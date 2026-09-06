export type ClientId =
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "pi"
  | "conductor"
  | "orca";

type ConfiguredSetup = {
  readonly kind: "command" | "configuration";
  readonly label: string;
  readonly copyLabel: string;
  readonly value: string;
  readonly note: string;
};

type InheritedSetup = {
  readonly kind: "inherited";
  readonly label: string;
  readonly note: string;
};

export type ClientSetup = ConfiguredSetup | InheritedSetup;

export type AgentClient = {
  readonly id: ClientId;
  readonly name: string;
  readonly logoPath: string;
  readonly supportLabel: string;
  readonly setup: ClientSetup;
};

export const CLIENTS: readonly AgentClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    logoPath: "/client-logos/claude-code.ico",
    supportLabel: "Native setup · automatic hooks",
    setup: {
      kind: "command",
      label: "RUN IN YOUR TERMINAL",
      copyLabel: "command",
      value:
        "claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp",
      note: "Adds Murmur’s public setup connection. The authenticated setup can also install passive lifecycle hooks.",
    },
  },
  {
    id: "codex",
    name: "Codex",
    logoPath: "/client-logos/codex.svg",
    supportLabel: "Native setup · automatic hooks",
    setup: {
      kind: "command",
      label: "RUN IN YOUR TERMINAL",
      copyLabel: "command",
      value: "codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp",
      note: "Adds Murmur’s public setup connection. The authenticated setup can also install passive lifecycle hooks.",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    logoPath: "/client-logos/opencode.svg",
    supportLabel: "Native config · manual lifecycle",
    setup: {
      kind: "configuration",
      label: "ADD TO ~/.config/opencode/opencode.json",
      copyLabel: "configuration",
      value:
        '{\n  "mcp": {\n    "murmur": {\n      "type": "remote",\n      "url": "https://api.usemurmur.dev/setup/mcp",\n      "enabled": true\n    }\n  }\n}',
      note: "OpenCode has native remote MCP configuration. Restart it after adding the public setup connection; lifecycle checks remain manual.",
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    logoPath: "/client-logos/cursor.svg",
    supportLabel: "Native config · manual lifecycle",
    setup: {
      kind: "configuration",
      label: "ADD TO ~/.cursor/mcp.json",
      copyLabel: "configuration",
      value:
        '{\n  "mcpServers": {\n    "murmur": {\n      "url": "https://api.usemurmur.dev/setup/mcp"\n    }\n  }\n}',
      note: "Cursor has native remote MCP configuration. Restart it after adding the public setup connection; lifecycle checks remain manual.",
    },
  },
  {
    id: "pi",
    name: "Pi",
    logoPath: "/client-logos/pi.svg",
    supportLabel: "Third-party adapter in Pi’s catalog · manual lifecycle",
    setup: {
      kind: "configuration",
      label: "INSTALL THE ADAPTER, THEN ADD ITS MCP CONFIG",
      copyLabel: "setup",
      value:
        'pi install npm:pi-mcp-adapter\n\n# Then add to ~/.config/mcp/mcp.json\n{\n  "mcpServers": {\n    "murmur": {\n      "url": "https://api.usemurmur.dev/setup/mcp"\n    }\n  }\n}',
      note: "Pi does not provide MCP by itself. Install the third-party adapter listed in Pi’s official package catalog, then restart Pi; lifecycle checks remain manual.",
    },
  },
  {
    id: "conductor",
    name: "Conductor",
    logoPath: "/client-logos/conductor.svg",
    supportLabel: "Inherits the launched agent",
    setup: {
      kind: "inherited",
      label: "CONFIGURE THE AGENT CONDUCTOR LAUNCHES",
      note: "Configure the Claude Code, Codex, Cursor, or OpenCode agent Conductor launches. Conductor then inherits Murmur and needs no separate entry.",
    },
  },
  {
    id: "orca",
    name: "Orca",
    logoPath: "/client-logos/orca.svg",
    supportLabel: "Inherits the launched agent",
    setup: {
      kind: "inherited",
      label: "CONFIGURE THE AGENT ORCA LAUNCHES",
      note: "Configure the Claude Code, Codex, Cursor, OpenCode, Pi, or other CLI agent selected in Orca. Orca then inherits Murmur and needs no separate entry.",
    },
  },
];

export function getClient(id: ClientId): AgentClient {
  for (const client of CLIENTS) {
    if (client.id === id) return client;
  }
  throw new Error(`Unknown client: ${id}`);
}
