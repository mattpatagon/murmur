export const DEFAULT_MURMUR_URL: string = "https://api.usemurmur.dev/mcp";
export const MURMUR_TOKEN_ENV: string = "MURMUR_API_TOKEN";

export type MurmurClient = "claude" | "codex";
export type SetupClient = MurmurClient | "cursor" | "opencode" | "pi";

export const DEFAULT_SETUP_CLIENTS: readonly SetupClient[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "pi",
];

export const PI_ADAPTER_NOTE: string =
  "Pi requires the third-party pi-mcp-adapter listed in Pi's official package catalog; Murmur does not install it.";

export function supportsLifecycleHooks(client: SetupClient): client is MurmurClient {
  return client === "claude" || client === "codex";
}
