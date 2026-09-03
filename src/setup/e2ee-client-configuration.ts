type JsonRecord = Record<string, unknown>;

type TomlSection = {
  readonly end: number;
  readonly name: string;
  readonly start: number;
};

const TOML_SECTION_MARKER: string = "__murmur_e2ee_section_marker__";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlSections(content: string): readonly TomlSection[] {
  const pattern: RegExp = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/gmu;
  const headers: Array<Omit<TomlSection, "end">> = [];
  for (const match of content.matchAll(pattern)) {
    const name: string | undefined = match[1];
    const start: number | undefined = match.index;
    if (name !== undefined && start !== undefined) headers.push({ name: name.trim(), start });
  }
  return headers.map((header: Omit<TomlSection, "end">, index: number): TomlSection => {
    const next: Omit<TomlSection, "end"> | undefined = headers[index + 1];
    return { ...header, end: next === undefined ? content.length : next.start };
  });
}

function containsMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value[TOML_SECTION_MARKER] === true) return true;
  return Object.values(value).some((nested: unknown): boolean => containsMarker(nested));
}

function isMurmurSection(name: string): boolean {
  try {
    const parsed: unknown = Bun.TOML.parse(`[${name}]\n${TOML_SECTION_MARKER} = true\n`);
    if (!isRecord(parsed)) return false;
    const servers: unknown = parsed["mcp_servers"];
    if (!isRecord(servers)) return false;
    const murmur: unknown = servers["murmur"];
    return isRecord(murmur) && containsMarker(murmur);
  } catch (_error: unknown) {
    return false;
  }
}

function removeMurmurTomlSections(content: string): string {
  const sections: readonly TomlSection[] = tomlSections(content).filter(
    (section: TomlSection): boolean => isMurmurSection(section.name),
  );
  let result: string = content;
  for (const section of [...sections].reverse()) {
    result = `${result.slice(0, section.start)}${result.slice(section.end)}`;
  }
  return result.trimEnd();
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every(
      (entry: unknown, index: number): boolean =>
        typeof entry === "string" && entry === expected[index],
    )
  );
}

function proxyArguments(
  url: string,
  client: "claude" | "codex",
  vaultPath?: string | undefined,
): readonly string[] {
  return [
    "--url",
    url,
    "--client",
    client,
    ...(vaultPath === undefined ? [] : ["--vault-path", vaultPath]),
  ];
}

function codexMurmurServer(content: string): JsonRecord | null {
  if (content.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch (_error: unknown) {
    throw new Error("Codex configuration must be valid TOML before E2E setup");
  }
  if (!isRecord(parsed)) return null;
  const servers: unknown = parsed["mcp_servers"];
  if (!isRecord(servers)) return null;
  const murmur: unknown = servers["murmur"];
  return isRecord(murmur) ? murmur : null;
}

function codexProxyBlock(url: string, executable: string, vaultPath?: string | undefined): string {
  return [
    "[mcp_servers.murmur]",
    `command = ${JSON.stringify(executable)}`,
    `args = ${JSON.stringify(proxyArguments(url, "codex", vaultPath))}`,
  ].join("\n");
}

export function configureCodexE2eeMcp(
  current: string,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): string {
  const expectedArguments: readonly string[] = proxyArguments(url, "codex", vaultPath);
  const existing: JsonRecord | null = codexMurmurServer(current);
  if (
    existing !== null &&
    existing["command"] === executable &&
    exactStringArray(existing["args"], expectedArguments) &&
    existing["url"] === undefined &&
    existing["bearer_token_env_var"] === undefined
  ) {
    return current;
  }
  const withoutMurmur: string = removeMurmurTomlSections(current);
  const hadMurmurConfiguration: boolean = withoutMurmur.trimEnd() !== current.trimEnd();
  if (hadMurmurConfiguration && !replace) {
    throw new Error(
      "Codex already has a different Murmur MCP configuration. Inspect it or rerun with --replace.",
    );
  }
  const prefix: string = withoutMurmur.trimEnd();
  return `${prefix === "" ? "" : `${prefix}\n\n`}${codexProxyBlock(url, executable, vaultPath)}\n`;
}

function claudeProxyServer(
  url: string,
  executable: string,
  vaultPath?: string | undefined,
): JsonRecord {
  return {
    args: proxyArguments(url, "claude", vaultPath),
    command: executable,
    type: "stdio",
  };
}

export function configureClaudeE2eeMcp(
  current: JsonRecord,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): JsonRecord {
  const result: JsonRecord = structuredClone(current);
  const servers: JsonRecord = isRecord(result["mcpServers"])
    ? structuredClone(result["mcpServers"])
    : {};
  const existing: unknown = servers["murmur"];
  const expectedArguments: readonly string[] = proxyArguments(url, "claude", vaultPath);
  if (
    isRecord(existing) &&
    existing["type"] === "stdio" &&
    existing["command"] === executable &&
    exactStringArray(existing["args"], expectedArguments) &&
    existing["url"] === undefined &&
    existing["headers"] === undefined
  ) {
    return current;
  }
  if (existing !== undefined && !replace) {
    throw new Error(
      "Claude already has a different Murmur MCP configuration. Inspect it or rerun with --replace.",
    );
  }
  servers["murmur"] = claudeProxyServer(url, executable, vaultPath);
  result["mcpServers"] = servers;
  return result;
}
