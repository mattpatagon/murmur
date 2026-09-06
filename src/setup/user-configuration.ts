import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import {
  environmentPath,
  type PathJoin,
  pathJoinForPlatform,
  userHomeDirectory,
} from "../platform-paths.js";
import { isBootstrapMurmurEndpoint } from "./bootstrap-configuration.js";
import {
  DEFAULT_MURMUR_URL,
  MURMUR_TOKEN_ENV,
  type MurmurClient,
  type SetupClient,
} from "./client-configuration.js";
import { configureCodexMcp } from "./codex-configuration.js";
import { configureClaudeE2eeMcp, configureCodexE2eeMcp } from "./e2ee-client-configuration.js";
import {
  configureCursorE2eeMcp,
  configureCursorMcp,
  configureOpenCodeE2eeMcp,
  configureOpenCodeMcp,
  configurePiE2eeMcp,
  configurePiMcp,
  isRecord,
  type JsonRecord,
  readJsonRecord,
} from "./json-client-configuration.js";

export type { MurmurClient, SetupClient } from "./client-configuration.js";
export { DEFAULT_MURMUR_URL, MURMUR_TOKEN_ENV } from "./client-configuration.js";
export { configureCodexMcp } from "./codex-configuration.js";
export {
  configureCursorE2eeMcp,
  configureCursorMcp,
  configureOpenCodeE2eeMcp,
  configureOpenCodeMcp,
  configurePiE2eeMcp,
  configurePiMcp,
} from "./json-client-configuration.js";

type PendingWrite = {
  readonly content: string;
  readonly path: string;
};

export type UserConfigurationPaths = {
  readonly claudeMcp: string;
  readonly claudeSettings: string;
  readonly codexConfig: string;
  readonly codexHooks: string;
  readonly cursorMcp: string;
  readonly opencodeConfig: string;
  readonly piMcp: string;
};

function readConfiguration(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  return readJsonRecord(path, (candidate: string): string => readFileSync(candidate, "utf8"));
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode: number = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporaryPath: string = join(dirname(path), `.murmur-${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: existingMode });
  renameSync(temporaryPath, path);
  chmodSync(path, existingMode);
}

function claudeMcpServer(url: string, existingHeaders: JsonRecord = {}): JsonRecord {
  const portableHeaders: JsonRecord = Object.fromEntries(
    Object.entries(existingHeaders).filter(
      ([name]: [string, unknown]): boolean =>
        name !== "X-Murmur-Repository" && name !== "X-Murmur-Branch",
    ),
  );
  return {
    type: "http",
    url,
    headers: {
      ...portableHeaders,
      Authorization: `Bearer \${${MURMUR_TOKEN_ENV}}`,
      "X-Murmur-Client": "claude",
    },
  };
}

export function configureClaudeMcp(
  current: JsonRecord,
  url: string,
  replace: boolean = false,
): JsonRecord {
  const result: JsonRecord = structuredClone(current);
  const servers: JsonRecord = isRecord(result["mcpServers"])
    ? structuredClone(result["mcpServers"])
    : {};
  const existing: unknown = servers["murmur"];
  if (existing !== undefined && isRecord(existing)) {
    const existingUrl: unknown = existing["url"];
    const existingType: unknown = existing["type"];
    const bootstrap: boolean =
      existingType === "http" && isBootstrapMurmurEndpoint(existingUrl, url);
    if ((existingUrl !== url || existingType !== "http") && !replace && !bootstrap) {
      throw new Error(
        "Claude already has a different user-scoped Murmur MCP server. Inspect it or rerun with --replace.",
      );
    }
    const headers: JsonRecord = isRecord(existing["headers"])
      ? structuredClone(existing["headers"])
      : {};
    servers["murmur"] = claudeMcpServer(url, replace || bootstrap ? {} : headers);
  } else if (existing !== undefined && !replace) {
    throw new Error(
      "Claude already has an invalid user-scoped Murmur MCP server. Inspect it or rerun with --replace.",
    );
  } else {
    servers["murmur"] = claudeMcpServer(url);
  }
  result["mcpServers"] = servers;
  return result;
}

const HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

function isMurmurHookGroup(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value["hooks"])) return false;
  return value["hooks"].some(
    (hook: unknown): boolean =>
      isRecord(hook) &&
      typeof hook["command"] === "string" &&
      /(?:^|\/)murmur-hook(?:['"])?(?:\s|$)/u.test(hook["command"]),
  );
}

function hookGroup(command: string): JsonRecord {
  return {
    hooks: [
      {
        type: "command",
        command,
        timeout: 5,
      },
    ],
  };
}

export function configureHooks(
  current: JsonRecord,
  client: MurmurClient,
  hookExecutable: string,
  e2ee: boolean = false,
  e2eeVaultPath?: string | undefined,
): JsonRecord {
  const result: JsonRecord = structuredClone(current);
  const hooks: JsonRecord = isRecord(result["hooks"]) ? structuredClone(result["hooks"]) : {};
  const vaultArgument: string =
    e2ee && e2eeVaultPath !== undefined ? ` --vault-path ${shellQuote(e2eeVaultPath)}` : "";
  const command: string = `${shellQuote(hookExecutable)} --client ${client}${e2ee ? " --e2ee" : ""}${vaultArgument}`;
  for (const event of HOOK_EVENTS) {
    const existing: unknown = hooks[event];
    const groups: unknown[] = Array.isArray(existing) ? existing : [];
    hooks[event] = [
      ...groups.filter((group: unknown): boolean => !isMurmurHookGroup(group)),
      hookGroup(command),
    ];
  }
  result["hooks"] = hooks;
  return result;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function defaultUserConfigurationPaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): UserConfigurationPaths {
  const joinTargetPath: PathJoin = pathJoinForPlatform(platform);
  const home: string = userHomeDirectory(environment, platform);
  const configuredCodexHome: string | null = environmentPath(environment, "CODEX_HOME");
  const configuredClaudeDirectory: string | null = environmentPath(
    environment,
    "CLAUDE_CONFIG_DIR",
  );
  const codexHome: string = configuredCodexHome ?? joinTargetPath(home, ".codex");
  const claudeDirectory: string = configuredClaudeDirectory ?? joinTargetPath(home, ".claude");
  return {
    claudeMcp:
      configuredClaudeDirectory === null
        ? joinTargetPath(home, ".claude.json")
        : joinTargetPath(configuredClaudeDirectory, ".claude.json"),
    claudeSettings: joinTargetPath(claudeDirectory, "settings.json"),
    codexConfig: joinTargetPath(codexHome, "config.toml"),
    codexHooks: joinTargetPath(codexHome, "hooks.json"),
    cursorMcp: joinTargetPath(home, ".cursor", "mcp.json"),
    opencodeConfig: joinTargetPath(home, ".config", "opencode", "opencode.json"),
    piMcp: joinTargetPath(home, ".config", "mcp", "mcp.json"),
  };
}

function addJsonWrite(
  pendingWrites: PendingWrite[],
  path: string,
  configure: (current: JsonRecord) => JsonRecord,
): void {
  const current: JsonRecord = readConfiguration(path);
  const next: JsonRecord = configure(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  pendingWrites.push({ content: `${JSON.stringify(next, null, 2)}\n`, path });
}

export function installUserConfiguration(options: {
  readonly clients: readonly SetupClient[];
  readonly e2ee?: boolean | undefined;
  readonly e2eeProxyExecutable?: string | undefined;
  readonly e2eeVaultPath?: string | undefined;
  readonly hookExecutable?: string | undefined;
  readonly paths?: UserConfigurationPaths | undefined;
  readonly replace?: boolean | undefined;
  readonly url?: string | undefined;
}): readonly string[] {
  const paths: UserConfigurationPaths = options.paths ?? defaultUserConfigurationPaths();
  const replace: boolean = options.replace ?? false;
  const url: string = options.url ?? DEFAULT_MURMUR_URL;
  const pendingWrites: PendingWrite[] = [];
  const e2ee: boolean = options.e2ee === true;
  const proxyExecutable: string | undefined = options.e2eeProxyExecutable;
  const vaultPath: string | undefined = options.e2eeVaultPath;
  const hookExecutable: string | undefined = options.hookExecutable;
  if (e2ee && proxyExecutable === undefined) {
    throw new Error("E2E setup requires the local proxy executable");
  }
  if (vaultPath !== undefined && (!e2ee || !isAbsolute(vaultPath))) {
    throw new Error("A custom E2E vault path requires E2E setup and an absolute path");
  }
  if (
    (options.clients.includes("codex") || options.clients.includes("claude")) &&
    hookExecutable === undefined
  ) {
    throw new Error("Claude and Codex setup requires the local hook executable");
  }

  if (options.clients.includes("codex") && hookExecutable !== undefined) {
    const currentConfig: string = existsSync(paths.codexConfig)
      ? readFileSync(paths.codexConfig, "utf8")
      : "";
    const nextConfig: string =
      e2ee && proxyExecutable !== undefined
        ? configureCodexE2eeMcp(currentConfig, url, proxyExecutable, replace, vaultPath)
        : configureCodexMcp(currentConfig, url, replace);
    if (nextConfig !== currentConfig) {
      pendingWrites.push({ content: nextConfig, path: paths.codexConfig });
    }
    addJsonWrite(
      pendingWrites,
      paths.codexHooks,
      (current: JsonRecord): JsonRecord =>
        configureHooks(current, "codex", hookExecutable, e2ee, vaultPath),
    );
  }

  if (options.clients.includes("claude") && hookExecutable !== undefined) {
    addJsonWrite(
      pendingWrites,
      paths.claudeMcp,
      (current: JsonRecord): JsonRecord =>
        e2ee && proxyExecutable !== undefined
          ? configureClaudeE2eeMcp(current, url, proxyExecutable, replace, vaultPath)
          : configureClaudeMcp(current, url, replace),
    );
    addJsonWrite(
      pendingWrites,
      paths.claudeSettings,
      (current: JsonRecord): JsonRecord =>
        configureHooks(current, "claude", hookExecutable, e2ee, vaultPath),
    );
  }

  if (options.clients.includes("opencode")) {
    addJsonWrite(
      pendingWrites,
      paths.opencodeConfig,
      (current: JsonRecord): JsonRecord =>
        e2ee && proxyExecutable !== undefined
          ? configureOpenCodeE2eeMcp(current, url, proxyExecutable, replace, vaultPath)
          : configureOpenCodeMcp(current, url, replace),
    );
  }

  if (options.clients.includes("cursor")) {
    addJsonWrite(
      pendingWrites,
      paths.cursorMcp,
      (current: JsonRecord): JsonRecord =>
        e2ee && proxyExecutable !== undefined
          ? configureCursorE2eeMcp(current, url, proxyExecutable, replace, vaultPath)
          : configureCursorMcp(current, url, replace),
    );
  }

  if (options.clients.includes("pi")) {
    addJsonWrite(
      pendingWrites,
      paths.piMcp,
      (current: JsonRecord): JsonRecord =>
        e2ee && proxyExecutable !== undefined
          ? configurePiE2eeMcp(current, url, proxyExecutable, replace, vaultPath)
          : configurePiMcp(current, url, replace),
    );
  }

  for (const pending of pendingWrites) writeFileAtomic(pending.path, pending.content);
  return pendingWrites.map((pending: PendingWrite): string => pending.path);
}
