import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentClient, CLIENTS, type ClientId, getClient } from "../src/data/clients";

const PUBLIC_DIRECTORY: string = fileURLToPath(new URL("../public/", import.meta.url));
const EXPECTED_IDS: readonly ClientId[] = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "pi",
  "conductor",
  "orca",
];

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("client catalog has the seven reviewed harnesses in presentation order", (): void => {
  const ids: readonly ClientId[] = CLIENTS.map((client: AgentClient): ClientId => client.id);
  expect(ids).toEqual(EXPECTED_IDS);
  expect(new Set<ClientId>(ids).size).toBe(ids.length);
});

test("client catalog uses the exact reviewed self-hosted assets", (): void => {
  const manifestPath: string = join(PUBLIC_DIRECTORY, "client-logos/checksums.sha256");
  const checksumLines: readonly string[] = readFileSync(manifestPath, "utf8").trim().split("\n");
  const expectedHashes: Map<string, string> = new Map<string, string>();
  for (const line of checksumLines) {
    const fields: RegExpMatchArray | null = line.match(/^([0-9a-f]{64}) {2}([a-z0-9.-]+)$/u);
    if (fields === null) throw new Error(`Invalid client asset checksum line: ${line}`);
    const hash: string | undefined = fields[1];
    const fileName: string | undefined = fields[2];
    if (hash === undefined || fileName === undefined) {
      throw new Error(`Incomplete client asset checksum line: ${line}`);
    }
    expectedHashes.set(fileName, hash);
  }
  expect(expectedHashes.size).toBe(CLIENTS.length);
  for (const client of CLIENTS) {
    expect(client.logoPath.startsWith("/client-logos/")).toBe(true);
    const assetPath: string = join(PUBLIC_DIRECTORY, client.logoPath.slice(1));
    const expectedHash: string | undefined = expectedHashes.get(basename(assetPath));
    if (expectedHash === undefined) throw new Error(`Missing checksum for ${client.name}`);
    expect(digest(assetPath)).toBe(expectedHash);
  }
});

test("Pi is presented as a third-party adapter with official-catalog provenance", (): void => {
  const pi: AgentClient = getClient("pi");
  expect(pi.supportLabel).toContain("Third-party adapter");
  expect(pi.setup.note).toContain("third-party adapter listed in Pi’s official package catalog");
});

test("catalog support tiers match each client integration", (): void => {
  expect(getClient("claude-code").supportLabel).toContain("automatic hooks");
  expect(getClient("codex").supportLabel).toContain("automatic hooks");
  expect(getClient("opencode").setup.kind).toBe("configuration");
  expect(getClient("cursor").setup.kind).toBe("configuration");
  expect(getClient("conductor").setup.kind).toBe("inherited");
  expect(getClient("orca").setup.kind).toBe("inherited");
});

test("client presentation surfaces contain no generic glyph or letter avatars", (): void => {
  const surfaces: readonly string[] = [
    readFileSync(join(PUBLIC_DIRECTORY, "../src/pages/index.astro"), "utf8"),
    readFileSync(join(PUBLIC_DIRECTORY, "../src/components/HandoffDemo.tsx"), "utf8"),
  ];
  for (const source of surfaces) {
    expect(source).not.toContain("✳");
    expect(source).not.toContain("⌘");
    expect(source).not.toContain('className="agent-avatar">C');
    expect(source).not.toContain('className="agent-avatar">X');
  }
});

test("the official Murmur favicon is present and linked", (): void => {
  const favicon: string = readFileSync(join(PUBLIC_DIRECTORY, "favicon.svg"), "utf8");
  const layout: string = readFileSync(join(PUBLIC_DIRECTORY, "../src/layouts/Page.astro"), "utf8");
  expect(favicon).toContain("<svg");
  expect(layout).toContain('rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg"');
});
