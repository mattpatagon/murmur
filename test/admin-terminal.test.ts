import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  type AdminCliRuntime,
  answerAdminApproval,
  parseAdminArguments,
  readAdminArguments,
  runAdminCli,
} from "../src/admin/terminal-client.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { testEnvironment } from "./support/http-mcp-harness.js";

const RUNTIME: AdminCliRuntime = {
  confirm: async (): Promise<boolean> => false,
  interactive: true,
  token: "test-murmur-api-token",
};

test("terminal client discovers schemas, executes MCP operations, and handles safe failures", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-admin-terminal-"));
  const server: MurmurHttpServer = await startHttpServer(
    testEnvironment(join(directory, "messages.db")),
  );
  try {
    const url: string = server.mcpUrl.toString();
    const tools: string = await runAdminCli(["tools", "--url", url], RUNTIME);
    expect(tools).toContain("register_agent");
    expect(tools).toContain("inputSchema");
    const argumentsFile: string = join(directory, "registration.json");
    writeFileSync(
      argumentsFile,
      JSON.stringify({ agent_id: "terminal-client", display_name: "Terminal client" }),
    );
    const registered: string = await runAdminCli(
      ["register_agent", "--url", url, "--arguments-file", argumentsFile],
      RUNTIME,
    );
    expect(registered).toContain("terminal-client");
    await expect(runAdminCli(["unknown_tool", "--url", url], RUNTIME)).rejects.toThrow(
      "admin operation failed",
    );
    await expect(
      runAdminCli(["tools", "--url", url], { ...RUNTIME, token: "wrong-token" }),
    ).rejects.toThrow("no success was confirmed");
    await expect(runAdminCli(["tools"], { ...RUNTIME, token: undefined })).rejects.toThrow(
      "MURMUR_ADMIN_TOKEN",
    );
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("terminal arguments are bounded JSON and endpoint options cannot hide credentials", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-admin-input-"));
  const path: string = join(directory, "arguments.json");
  try {
    expect(readAdminArguments(null)).toEqual({});
    writeFileSync(path, JSON.stringify([1, 2]));
    expect((): unknown => readAdminArguments(path)).toThrow();
    writeFileSync(path, "x".repeat(32_769));
    expect((): unknown => readAdminArguments(path)).toThrow("32 KiB");
    expect((): unknown => parseAdminArguments([])).toThrow("Usage");
    expect((): unknown => parseAdminArguments(["tools", "--unexpected", "value"])).toThrow(
      "Unknown",
    );
    expect((): unknown =>
      parseAdminArguments([
        "tools",
        "--url",
        "https://example.org",
        "--url",
        "https://example.org",
      ]),
    ).toThrow("repeated");
    expect((): unknown =>
      parseAdminArguments(["tools", "--url", "https://example.org/mcp?token=secret"]),
    ).toThrow("credentials");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("terminal consent rejects URL requests and unexpected forms without asking the human", async (): Promise<void> => {
  let prompts: number = 0;
  const confirm: () => Promise<boolean> = async (): Promise<boolean> => {
    prompts += 1;
    return true;
  };
  const urlRequest: ElicitRequest = {
    method: "elicitation/create",
    params: {
      mode: "url",
      message: "Unrelated",
      url: "https://example.org",
      elicitationId: "unrelated",
    },
  };
  expect((await answerAdminApproval(urlRequest, confirm)).action).toBe("decline");
  const formRequest: ElicitRequest = {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Unrelated",
      requestedSchema: { type: "object", properties: { password: { type: "string" } } },
    },
  };
  expect((await answerAdminApproval(formRequest, confirm)).action).toBe("decline");
  expect(prompts).toBe(0);
});
