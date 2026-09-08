export const OMP_EXTENSION_MARKER: string = "// murmur-managed:omp";

export type OmpExtensionOptions = {
  readonly e2ee: boolean;
  readonly hookExecutable: string;
  readonly url: string;
  readonly vaultPath?: string | undefined;
};

export function ompHookCommand(options: OmpExtensionOptions): readonly string[] {
  return [
    options.hookExecutable,
    "--client",
    "omp",
    ...(options.e2ee ? ["--e2ee"] : []),
    ...(options.vaultPath === undefined ? [] : ["--vault-path", options.vaultPath]),
  ];
}

// The generated file runs inside Oh My Pi's Bun runtime, not inside Murmur, so it stays
// self-contained: no imports, no template literals, and only the host extension API it needs.
export function ompExtensionSource(options: OmpExtensionOptions): string {
  const command: string = JSON.stringify(ompHookCommand(options));
  const url: string = JSON.stringify(options.url);
  return `${OMP_EXTENSION_MARKER}
// Managed by Murmur setup. Rerun "murmur setup --user --omp" to regenerate; manual edits are lost.
// Bridges Oh My Pi session events to the passive murmur-hook lifecycle used by Claude Code and
// Codex: session_start registers, active-turn events reread the durable inbox, agent_end ends the
// session lease, and session_shutdown closes the session-scoped identity. Hook output is injected
// as coordination context for the current or next turn; it never starts a turn for an idle model.

const HOOK_COMMAND: readonly string[] = ${command};
const MURMUR_URL: string = ${url};
const HOOK_TIMEOUT_MS: number = 5000;
const MESSAGE_TYPE: string = "murmur";
const SERVER_NAME: string = "murmur";

type SessionManagerLike = { getSessionId(): string };
type ContextLike = { cwd: string; isIdle(): boolean; sessionManager: SessionManagerLike };
type MessageLike = { content: string; customType: string; display: boolean };
type DeliverAs = "aside" | "followUp" | "nextTurn" | "steer";
type Handler = (event: unknown, ctx: ContextLike) => unknown;
type ExtensionApiLike = {
  on(event: string, handler: Handler): void;
  sendMessage(message: MessageLike, options?: { deliverAs?: DeliverAs }): void;
};

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field.trim() !== "" ? field : null;
}

function hookContent(stdout: string): string | null {
  const trimmed: string = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_error: unknown) {
    return null;
  }
  const systemMessage: string | null = stringField(parsed, "systemMessage");
  const specific: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "hookSpecificOutput") : null;
  const additionalContext: string | null = stringField(specific, "additionalContext");
  const parts: string[] = [];
  if (systemMessage !== null) parts.push(systemMessage);
  if (additionalContext !== null) parts.push(additionalContext);
  return parts.length === 0 ? null : parts.join("\\n\\n");
}

function sessionId(ctx: ContextLike): string | undefined {
  try {
    const id: string = ctx.sessionManager.getSessionId();
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch (_error: unknown) {
    return undefined;
  }
}

async function runHook(eventName: string, ctx: ContextLike): Promise<string | null> {
  const input: string = JSON.stringify({
    cwd: ctx.cwd,
    hook_event_name: eventName,
    session_id: sessionId(ctx),
  });
  let child: Bun.Subprocess<"pipe" | Blob, "pipe", "ignore">;
  try {
    child = Bun.spawn([...HOOK_COMMAND], {
      env: { ...process.env, MURMUR_MCP_URL: MURMUR_URL },
      stderr: "ignore",
      stdin: new Blob([input]),
      stdout: "pipe",
    });
  } catch (_error: unknown) {
    return null;
  }
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    child.kill();
  }, HOOK_TIMEOUT_MS);
  try {
    const stdout: string = await new Response(child.stdout).text();
    const exitCode: number = await child.exited;
    return exitCode === 0 ? hookContent(stdout) : null;
  } catch (_error: unknown) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next: Promise<T> = queue.then(task, task);
  queue = next.catch((): undefined => undefined);
  return next;
}

function message(content: string): MessageLike {
  return { content, customType: MESSAGE_TYPE, display: true };
}

function isInboxUpdate(event: unknown): boolean {
  return (
    stringField(event, "server") === SERVER_NAME &&
    stringField(event, "method") === "notifications/resources/updated"
  );
}

export default function murmur(pi: ExtensionApiLike): void {
  pi.on("session_start", async (_event: unknown, ctx: ContextLike): Promise<void> => {
    const content: string | null = await enqueue(() => runHook("SessionStart", ctx));
    if (content !== null) pi.sendMessage(message(content), { deliverAs: "nextTurn" });
  });
  pi.on("before_agent_start", async (_event: unknown, ctx: ContextLike): Promise<unknown> => {
    const content: string | null = await enqueue(() => runHook("UserPromptSubmit", ctx));
    return content === null ? undefined : { message: message(content) };
  });
  pi.on("tool_result", async (_event: unknown, ctx: ContextLike): Promise<void> => {
    const content: string | null = await enqueue(() => runHook("PostToolUse", ctx));
    if (content !== null) pi.sendMessage(message(content), { deliverAs: "aside" });
  });
  pi.on("mcp_notification", (event: unknown, ctx: ContextLike): void => {
    if (!isInboxUpdate(event) || ctx.isIdle()) return;
    pi.sendMessage(
      message("Murmur: the durable inbox changed. Call get_messages before overlapping work."),
      { deliverAs: "aside" },
    );
  });
  pi.on("agent_end", async (event: unknown, ctx: ContextLike): Promise<void> => {
    if (typeof event === "object" && event !== null && Reflect.get(event, "willContinue") === true) {
      return;
    }
    await enqueue(() => runHook("Stop", ctx));
  });
  pi.on("session_shutdown", async (_event: unknown, ctx: ContextLike): Promise<void> => {
    await enqueue(() => runHook("SessionEnd", ctx));
  });
}
`;
}

export function configureOmpExtension(
  current: string,
  options: OmpExtensionOptions,
  replace: boolean = false,
): string {
  const next: string = ompExtensionSource(options);
  if (current === "" || current === next) return next;
  const firstLine: string = current.split(/\r?\n/u, 1)[0] ?? "";
  if (firstLine.trim() === OMP_EXTENSION_MARKER || replace) return next;
  throw new Error(
    "Oh My Pi already has an unmanaged extensions/murmur.ts. Inspect it or rerun with --replace.",
  );
}
