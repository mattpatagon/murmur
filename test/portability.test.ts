import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";
import { z } from "zod";

const projectRoot: string = resolve(".");

const ClaudeConfigurationSchema: z.ZodType<{
  readonly mcpServers: {
    readonly murmur: {
      readonly headers: {
        readonly Authorization: string;
        readonly "X-Murmur-Client": "claude";
        readonly "X-Murmur-Repository": string;
      };
      readonly type: "http";
      readonly url: string;
    };
  };
}> = z.strictObject({
  mcpServers: z.strictObject({
    murmur: z.strictObject({
      headers: z.strictObject({
        Authorization: z.string(),
        "X-Murmur-Client": z.literal("claude"),
        "X-Murmur-Repository": z.string(),
      }),
      type: z.literal("http"),
      url: z.url(),
    }),
  }),
});

const PackageManifestSchema: z.ZodType<{
  readonly bin: {
    readonly murmur: string;
    readonly "murmur-hook": string;
    readonly "murmur-mcp": string;
  };
  readonly engines: { readonly bun: string };
}> = z
  .object({
    bin: z.strictObject({
      murmur: z.string(),
      "murmur-hook": z.string(),
      "murmur-mcp": z.string(),
    }),
    engines: z.strictObject({ bun: z.string() }),
  })
  .loose();

function readWorkspaceFile(path: string): string {
  return readFileSync(join(projectRoot, path), "utf8");
}

function expectNoMachineSpecificPath(contents: string): void {
  expect(contents).not.toContain(projectRoot);
  expect(contents).not.toMatch(/\/Users\/[^/]+\//u);
  expect(contents).not.toMatch(/\/home\/[^/]+\//u);
  expect(contents).not.toMatch(/[A-Za-z]:\\\\/u);
}

test("Claude project MCP configuration uses the authenticated remote server", (): void => {
  const configurationText: string = readWorkspaceFile(".mcp.json");
  const rawConfiguration: unknown = JSON.parse(configurationText);
  const configuration: z.infer<typeof ClaudeConfigurationSchema> =
    ClaudeConfigurationSchema.parse(rawConfiguration);

  expect(configuration.mcpServers.murmur.url).toBe("https://api.usemurmur.dev/mcp");
  expect(configuration.mcpServers.murmur.headers.Authorization).toBe(`Bearer \${MURMUR_API_TOKEN}`);
  expect(configuration.mcpServers.murmur.headers["X-Murmur-Client"]).toBe("claude");
  expect(configuration.mcpServers.murmur.headers["X-Murmur-Repository"]).toBe("mattpatagon/murmur");
  expectNoMachineSpecificPath(configurationText);
});

test("Codex project MCP configuration uses the authenticated remote server", (): void => {
  const configurationText: string = readWorkspaceFile(".codex/config.toml");

  expect(configurationText).toContain('url = "https://api.usemurmur.dev/mcp"');
  expect(configurationText).toContain('bearer_token_env_var = "MURMUR_API_TOKEN"');
  expect(configurationText).toContain(
    'http_headers = { "X-Murmur-Client" = "codex", "X-Murmur-Repository" = "mattpatagon/murmur" }',
  );
  expect(configurationText).toContain("required = false");
  expect(configurationText).not.toContain("command =");
  expect(configurationText).not.toContain("MURMUR_DATABASE_URL");
  expectNoMachineSpecificPath(configurationText);
});

test("the package exposes a location-independent MCP executable", (): void => {
  const rawManifest: unknown = JSON.parse(readWorkspaceFile("package.json"));
  const manifest: z.infer<typeof PackageManifestSchema> = PackageManifestSchema.parse(rawManifest);

  expect(manifest.bin.murmur).toBe("./src/cli.ts");
  expect(manifest.bin["murmur-hook"]).toBe("./src/hook.ts");
  expect(manifest.bin["murmur-mcp"]).toBe("./src/server.ts");
  expect(manifest.engines.bun).toBe(">=1.3.11");
});

test("CI enforces the portable contract on Linux, macOS, and Windows", (): void => {
  const workflow: string = readWorkspaceFile(".github/workflows/ci.yml");
  expect(workflow).toContain("ubuntu-latest");
  expect(workflow).toContain("macos-latest");
  expect(workflow).toContain("windows-latest");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("bun run verify");
  expect(workflow).toContain("bun run test:portability");
  expect(workflow).toContain("bun run build\n");
  expect(workflow).toContain("bun run build:http");
});
