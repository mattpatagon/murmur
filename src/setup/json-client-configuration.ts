import { isBootstrapMurmurEndpoint } from "./bootstrap-configuration.js";
import { MURMUR_TOKEN_ENV, type SetupClient } from "./client-configuration.js";

export type JsonRecord = Record<string, unknown>;

type JsonClient = "cursor" | "fx" | "opencode" | "pi";

type JsonClientFormat = {
  readonly client: JsonClient;
  readonly rootKey: "mcp" | "mcpServers";
};

const CURSOR_FORMAT: JsonClientFormat = { client: "cursor", rootKey: "mcpServers" };
const FX_FORMAT: JsonClientFormat = { client: "fx", rootKey: "mcp" };
const OPENCODE_FORMAT: JsonClientFormat = { client: "opencode", rootKey: "mcp" };
const PI_FORMAT: JsonClientFormat = { client: "pi", rootKey: "mcpServers" };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonRecord(path: string, read: (path: string) => string): JsonRecord {
  const parsed: unknown = JSON.parse(read(path));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function portableHeaders(existing: unknown): JsonRecord {
  if (!isRecord(existing)) return {};
  const managedHeaders: ReadonlySet<string> = new Set([
    "authorization",
    "x-murmur-branch",
    "x-murmur-client",
    "x-murmur-repository",
  ]);
  return Object.fromEntries(
    Object.entries(existing).filter(
      ([name]: [string, unknown]): boolean => !managedHeaders.has(name.toLowerCase()),
    ),
  );
}

function fxRemoteOptions(existing: unknown): JsonRecord {
  if (!isRecord(existing)) return {};
  const options: JsonRecord = {};
  if (typeof existing["required"] === "boolean") options["required"] = existing["required"];
  const timeoutNames: readonly string[] = ["startup_timeout_ms", "operation_timeout_ms"];
  for (const name of timeoutNames) {
    const value: unknown = existing[name];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      options[name] = value;
    }
  }
  return options;
}

function remoteServer(format: JsonClientFormat, url: string, existing: unknown): JsonRecord {
  const headers: JsonRecord = portableHeaders(isRecord(existing) ? existing["headers"] : undefined);
  if (format.client === "opencode") {
    return {
      enabled: true,
      headers: {
        ...headers,
        Authorization: `Bearer {env:${MURMUR_TOKEN_ENV}}`,
        "X-Murmur-Client": "opencode",
      },
      oauth: false,
      type: "remote",
      url,
    };
  }
  if (format.client === "cursor") {
    return {
      headers: {
        ...headers,
        Authorization: `Bearer \${env:${MURMUR_TOKEN_ENV}}`,
        "X-Murmur-Client": "cursor",
      },
      url,
    };
  }
  if (format.client === "fx") {
    return {
      ...fxRemoteOptions(existing),
      bearer_token_env: MURMUR_TOKEN_ENV,
      enabled: true,
      headers: { ...headers, "X-Murmur-Client": "fx" },
      type: "http",
      url,
    };
  }
  return {
    auth: "bearer",
    bearerTokenEnv: MURMUR_TOKEN_ENV,
    headers: { ...headers, "X-Murmur-Client": "pi" },
    url,
  };
}

function remoteShapeMatches(format: JsonClientFormat, existing: JsonRecord, url: string): boolean {
  if (existing["url"] !== url || existing["command"] !== undefined) return false;
  if (format.client === "opencode") return existing["type"] === "remote";
  if (format.client === "fx") return existing["type"] === "http";
  return true;
}

function serverCollection(
  current: JsonRecord,
  format: JsonClientFormat,
  replace: boolean,
): { readonly result: JsonRecord; readonly servers: JsonRecord } {
  const result: JsonRecord = structuredClone(current);
  const migrateFxAlias: boolean =
    format.client === "fx" && result["mcp"] === undefined && result["mcpServers"] !== undefined;
  const sourceKey: "mcp" | "mcpServers" = migrateFxAlias ? "mcpServers" : format.rootKey;
  const rawServers: unknown = result[sourceKey];
  if (rawServers !== undefined && !isRecord(rawServers) && !replace) {
    throw new Error(
      `${displayName(format)} has an invalid ${sourceKey} configuration. Inspect it or rerun with --replace.`,
    );
  }
  const servers: JsonRecord = isRecord(rawServers) ? structuredClone(rawServers) : {};
  if (migrateFxAlias) result["mcpServers"] = undefined;
  return { result, servers };
}

function displayName(format: JsonClientFormat): string {
  if (format.client === "opencode") return "OpenCode";
  if (format.client === "cursor") return "Cursor";
  if (format.client === "fx") return "fx";
  return "Pi";
}

function configureRemoteJsonClient(
  current: JsonRecord,
  format: JsonClientFormat,
  url: string,
  replace: boolean,
): JsonRecord {
  const configuration: { readonly result: JsonRecord; readonly servers: JsonRecord } =
    serverCollection(current, format, replace);
  const existing: unknown = configuration.servers["murmur"];
  const bootstrap: boolean = isRecord(existing) && isBootstrapMurmurEndpoint(existing["url"], url);
  const compatible: boolean = isRecord(existing) && remoteShapeMatches(format, existing, url);
  if (existing !== undefined && !replace && !bootstrap && !compatible) {
    throw new Error(
      `${displayName(format)} already has a different Murmur MCP configuration. Inspect it or rerun with --replace.`,
    );
  }
  configuration.servers["murmur"] = remoteServer(
    format,
    url,
    compatible && !replace ? existing : undefined,
  );
  configuration.result[format.rootKey] = configuration.servers;
  return configuration.result;
}

function proxyArguments(
  url: string,
  client: SetupClient,
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

function localServer(
  format: JsonClientFormat,
  url: string,
  executable: string,
  vaultPath?: string | undefined,
): JsonRecord {
  const arguments_: readonly string[] = proxyArguments(url, format.client, vaultPath);
  if (format.client === "opencode" || format.client === "fx") {
    return { command: [executable, ...arguments_], enabled: true, type: "local" };
  }
  if (format.client === "cursor") {
    return {
      args: arguments_,
      command: executable,
      env: { [MURMUR_TOKEN_ENV]: `\${env:${MURMUR_TOKEN_ENV}}` },
    };
  }
  return { args: arguments_, command: executable };
}

function localShapeMatches(
  format: JsonClientFormat,
  existing: JsonRecord,
  executable: string,
  arguments_: readonly string[],
): boolean {
  if (
    existing["url"] !== undefined ||
    existing["headers"] !== undefined ||
    existing["auth"] !== undefined ||
    existing["bearer_token_env"] !== undefined ||
    existing["bearerTokenEnv"] !== undefined ||
    existing["oauth"] !== undefined
  ) {
    return false;
  }
  if (format.client === "opencode" || format.client === "fx") {
    return (
      existing["type"] === "local" &&
      existing["enabled"] === true &&
      exactStringArray(existing["command"], [executable, ...arguments_])
    );
  }
  if (format.client === "cursor") {
    const environment: unknown = existing["env"];
    return (
      existing["command"] === executable &&
      exactStringArray(existing["args"], arguments_) &&
      isRecord(environment) &&
      environment[MURMUR_TOKEN_ENV] === `\${env:${MURMUR_TOKEN_ENV}}`
    );
  }
  return existing["command"] === executable && exactStringArray(existing["args"], arguments_);
}

function configureLocalJsonClient(
  current: JsonRecord,
  format: JsonClientFormat,
  url: string,
  executable: string,
  replace: boolean,
  vaultPath?: string | undefined,
): JsonRecord {
  const configuration: { readonly result: JsonRecord; readonly servers: JsonRecord } =
    serverCollection(current, format, replace);
  const existing: unknown = configuration.servers["murmur"];
  const arguments_: readonly string[] = proxyArguments(url, format.client, vaultPath);
  const expected: JsonRecord = localServer(format, url, executable, vaultPath);
  if (isRecord(existing) && localShapeMatches(format, existing, executable, arguments_)) {
    return current;
  }
  const bootstrap: boolean = isRecord(existing) && isBootstrapMurmurEndpoint(existing["url"], url);
  if (existing !== undefined && !replace && !bootstrap) {
    throw new Error(
      `${displayName(format)} already has a different Murmur MCP configuration. Inspect it or rerun with --replace.`,
    );
  }
  configuration.servers["murmur"] = expected;
  configuration.result[format.rootKey] = configuration.servers;
  return configuration.result;
}

export function configureOpenCodeMcp(
  current: JsonRecord,
  url: string,
  replace: boolean = false,
): JsonRecord {
  return configureRemoteJsonClient(current, OPENCODE_FORMAT, url, replace);
}

export function configureFxMcp(
  current: JsonRecord,
  url: string,
  replace: boolean = false,
): JsonRecord {
  return configureRemoteJsonClient(current, FX_FORMAT, url, replace);
}

export function configureCursorMcp(
  current: JsonRecord,
  url: string,
  replace: boolean = false,
): JsonRecord {
  return configureRemoteJsonClient(current, CURSOR_FORMAT, url, replace);
}

export function configurePiMcp(
  current: JsonRecord,
  url: string,
  replace: boolean = false,
): JsonRecord {
  return configureRemoteJsonClient(current, PI_FORMAT, url, replace);
}

export function configureOpenCodeE2eeMcp(
  current: JsonRecord,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): JsonRecord {
  return configureLocalJsonClient(current, OPENCODE_FORMAT, url, executable, replace, vaultPath);
}

export function configureFxE2eeMcp(
  current: JsonRecord,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): JsonRecord {
  return configureLocalJsonClient(current, FX_FORMAT, url, executable, replace, vaultPath);
}

export function configureCursorE2eeMcp(
  current: JsonRecord,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): JsonRecord {
  return configureLocalJsonClient(current, CURSOR_FORMAT, url, executable, replace, vaultPath);
}

export function configurePiE2eeMcp(
  current: JsonRecord,
  url: string,
  executable: string,
  replace: boolean = false,
  vaultPath?: string | undefined,
): JsonRecord {
  return configureLocalJsonClient(current, PI_FORMAT, url, executable, replace, vaultPath);
}
