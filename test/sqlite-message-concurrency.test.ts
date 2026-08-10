import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { z } from "zod";

import type { SendMessageCommand, SendMessageResult } from "../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  DisplayName,
  IdempotencyKey,
  MessageContent,
  RepositoryName,
} from "../src/domain/value-objects.js";
import { SqliteMessageStore } from "../src/storage/sqlite-message-store.js";

const WorkerResultSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{
      duplicate: z.ZodBoolean;
      messageId: z.ZodString;
      status: z.ZodLiteral<"sent">;
    }>,
    z.ZodObject<{
      errorClass: z.ZodString;
      message: z.ZodString;
      status: z.ZodLiteral<"error">;
    }>,
  ],
  "status"
> = z.discriminatedUnion("status", [
  z.object({ duplicate: z.boolean(), messageId: z.string(), status: z.literal("sent") }),
  z.object({ errorClass: z.string(), message: z.string(), status: z.literal("error") }),
]);

type WorkerResult = z.infer<typeof WorkerResultSchema>;

function requiredEnvironment(name: string): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function messageCommand(content: string): SendMessageCommand {
  return {
    branchName: BranchName.parse("feature/concurrent-retry"),
    client: AgentClient.parse("codex"),
    content: MessageContent.parse(content),
    idempotencyKey: IdempotencyKey.parse("concurrent-send"),
    recipientId: AgentId.parse("bob"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    senderId: AgentId.parse("alice"),
    threadId: null,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline: number = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function runWorker(): Promise<void> {
  const databasePath: string = requiredEnvironment("MURMUR_SQLITE_RACE_DATABASE");
  const goPath: string = requiredEnvironment("MURMUR_SQLITE_RACE_GO");
  const readyPath: string = requiredEnvironment("MURMUR_SQLITE_RACE_READY");
  const resultPath: string = requiredEnvironment("MURMUR_SQLITE_RACE_RESULT");
  const content: string = requiredEnvironment("MURMUR_SQLITE_RACE_CONTENT");
  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    writeFileSync(readyPath, "ready\n");
    await waitForFile(goPath);
    const sent: SendMessageResult = store.sendMessage(messageCommand(content));
    writeFileSync(
      resultPath,
      JSON.stringify({
        duplicate: sent.duplicate,
        messageId: sent.message.messageId.value,
        status: "sent",
      }),
    );
  } catch (error: unknown) {
    const errorClass: string = error instanceof Error ? error.constructor.name : typeof error;
    const message: string = error instanceof Error ? error.message : String(error);
    writeFileSync(resultPath, JSON.stringify({ errorClass, message, status: "error" }));
  } finally {
    store.close();
  }
}

function initializeDatabase(databasePath: string): void {
  const store: SqliteMessageStore = new SqliteMessageStore(databasePath);
  try {
    store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("Alice"),
      metadata: {},
    });
    store.registerAgent({
      agentId: AgentId.parse("bob"),
      displayName: DisplayName.parse("Bob"),
      metadata: {},
    });
  } finally {
    store.close();
  }
  const database: Database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TRIGGER delay_message_insert
      BEFORE INSERT ON messages
      BEGIN
        SELECT randomblob(16000000);
      END
    `);
  } finally {
    database.close();
  }
}

function spawnWorker(
  databasePath: string,
  goPath: string,
  readyPath: string,
  resultPath: string,
  content: string,
): Bun.Subprocess<"ignore", "ignore", "pipe"> {
  return Bun.spawn([process.execPath, "run", import.meta.path], {
    env: {
      MURMUR_SQLITE_RACE_CONTENT: content,
      MURMUR_SQLITE_RACE_DATABASE: databasePath,
      MURMUR_SQLITE_RACE_GO: goPath,
      MURMUR_SQLITE_RACE_READY: readyPath,
      MURMUR_SQLITE_RACE_RESULT: resultPath,
      MURMUR_SQLITE_RACE_WORKER: "1",
      PATH: process.env["PATH"] ?? "",
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
  });
}

async function runConcurrentSends(
  contents: readonly [string, string],
): Promise<readonly WorkerResult[]> {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-sqlite-race-"));
  const databasePath: string = join(directory, "messages.db");
  const goPath: string = join(directory, "go");
  const readyPaths: readonly [string, string] = [
    join(directory, "ready-1"),
    join(directory, "ready-2"),
  ];
  const resultPaths: readonly [string, string] = [
    join(directory, "result-1.json"),
    join(directory, "result-2.json"),
  ];
  initializeDatabase(databasePath);
  const workers: readonly [
    Bun.Subprocess<"ignore", "ignore", "pipe">,
    Bun.Subprocess<"ignore", "ignore", "pipe">,
  ] = [
    spawnWorker(databasePath, goPath, readyPaths[0], resultPaths[0], contents[0]),
    spawnWorker(databasePath, goPath, readyPaths[1], resultPaths[1], contents[1]),
  ];
  try {
    await Promise.all(readyPaths.map((path: string): Promise<void> => waitForFile(path)));
    writeFileSync(goPath, "go\n");
    const exitCodes: readonly number[] = await Promise.all(
      workers.map(
        (worker: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<number> => worker.exited,
      ),
    );
    const errors: readonly string[] = await Promise.all(
      workers.map(
        (worker: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<string> =>
          new Response(worker.stderr).text(),
      ),
    );
    expect(exitCodes).toEqual([0, 0]);
    expect(errors).toEqual(["", ""]);
    return resultPaths.map(
      (path: string): WorkerResult =>
        WorkerResultSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
    );
  } finally {
    workers.forEach((worker: Bun.Subprocess<"ignore", "ignore", "pipe">): void => {
      if (worker.exitCode === null) worker.kill();
    });
    await Promise.all(
      workers.map(
        (worker: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<number> => worker.exited,
      ),
    );
    rmSync(directory, { force: true, recursive: true });
  }
}

function expectIdenticalRetryResults(retries: readonly WorkerResult[]): void {
  expect(retries.every((result: WorkerResult): boolean => result.status === "sent")).toBe(true);
  const firstRetry: WorkerResult | undefined = retries[0];
  const secondRetry: WorkerResult | undefined = retries[1];
  if (
    firstRetry === undefined ||
    firstRetry.status !== "sent" ||
    secondRetry === undefined ||
    secondRetry.status !== "sent"
  ) {
    throw new Error("Expected both identical concurrent sends to resolve successfully");
  }
  expect([firstRetry.duplicate, secondRetry.duplicate].sort()).toEqual([false, true]);
  expect(firstRetry.messageId).toBe(secondRetry.messageId);
}

function expectConflictingRetryResults(conflicts: readonly WorkerResult[]): void {
  expect(
    conflicts.filter((result: WorkerResult): boolean => result.status === "sent"),
  ).toHaveLength(1);
  const failures: readonly WorkerResult[] = conflicts.filter(
    (result: WorkerResult): boolean => result.status === "error",
  );
  expect(failures).toHaveLength(1);
  const failure: WorkerResult | undefined = failures[0];
  if (failure === undefined || failure.status !== "error") {
    throw new Error("Expected one idempotency conflict");
  }
  expect(failure.errorClass).toBe("IdempotencyConflictError");
}

if (process.env["MURMUR_SQLITE_RACE_WORKER"] === "1") {
  await runWorker();
} else {
  test("resolves concurrent cross-process idempotent sends through the stored winner", async (): Promise<void> => {
    let attempt: number = 0;
    while (attempt < 5) {
      const retries: readonly WorkerResult[] = await runConcurrentSends([
        "Concurrent request",
        "Concurrent request",
      ]);
      expectIdenticalRetryResults(retries);
      const conflicts: readonly WorkerResult[] = await runConcurrentSends([
        "First request",
        "Conflicting request",
      ]);
      expectConflictingRetryResults(conflicts);
      attempt += 1;
    }
  }, 60_000);
}
