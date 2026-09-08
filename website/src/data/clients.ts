export type ClientId =
  | "claude-code"
  | "codex"
  | "fx"
  | "opencode"
  | "cursor"
  | "pi"
  | "conductor"
  | "orca";

export type SetupAction = {
  readonly label: string;
  readonly copyLabel: string;
  readonly value: string;
};

type ConfiguredSetup = {
  readonly kind: "command" | "configuration";
  readonly actions: readonly [SetupAction, ...SetupAction[]];
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
      actions: [
        {
          label: "RUN IN YOUR TERMINAL",
          copyLabel: "command",
          value:
            "claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp",
        },
      ],
      note: "Adds Murmur’s public setup connection. The authenticated setup can also install passive lifecycle hooks.",
    },
  },
  {
    id: "codex",
    name: "Codex",
    logoPath: "/client-logos/codex.png",
    supportLabel: "Native setup · automatic hooks",
    setup: {
      kind: "command",
      actions: [
        {
          label: "RUN IN YOUR TERMINAL",
          copyLabel: "command",
          value: "codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp",
        },
      ],
      note: "Adds Murmur’s public setup connection. The authenticated setup can also install passive lifecycle hooks.",
    },
  },
  {
    id: "fx",
    name: "fx",
    logoPath: "/client-logos/fx.svg",
    supportLabel: "Native setup · context injection",
    setup: {
      kind: "command",
      actions: [
        {
          label: "RUN IN YOUR TERMINAL",
          copyLabel: "command",
          value: "fx mcp add --transport http murmur https://api.usemurmur.dev/setup/mcp",
        },
      ],
      note: "Adds Murmur’s public setup connection. After signup, native Murmur setup adds the authenticated profile and managed fx coordination instructions. fx supports resource subscriptions and uses explicit lifecycle calls because it has no user hook API.",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    logoPath: "/client-logos/opencode.ico",
    supportLabel: "Native config · manual lifecycle",
    setup: {
      kind: "configuration",
      actions: [
        {
          label: "ADD TO ~/.config/opencode/opencode.json",
          copyLabel: "configuration",
          value:
            '{\n  "mcp": {\n    "murmur": {\n      "type": "remote",\n      "url": "https://api.usemurmur.dev/setup/mcp",\n      "enabled": true,\n      "oauth": false\n    }\n  }\n}',
        },
      ],
      note: "OpenCode has native remote MCP configuration. Restart it after adding the public setup connection; lifecycle checks remain manual.",
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    logoPath: "/client-logos/cursor.ico",
    supportLabel: "Native config · manual lifecycle",
    setup: {
      kind: "configuration",
      actions: [
        {
          label: "ADD TO ~/.cursor/mcp.json",
          copyLabel: "configuration",
          value:
            '{\n  "mcpServers": {\n    "murmur": {\n      "url": "https://api.usemurmur.dev/setup/mcp"\n    }\n  }\n}',
        },
      ],
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
      actions: [
        {
          label: "INSTALL THE THIRD-PARTY ADAPTER",
          copyLabel: "command",
          value: "pi install npm:pi-mcp-adapter",
        },
        {
          label: "THEN ADD TO ~/.config/mcp/mcp.json",
          copyLabel: "configuration",
          value:
            '{\n  "mcpServers": {\n    "murmur": {\n      "url": "https://api.usemurmur.dev/setup/mcp"\n    }\n  }\n}',
        },
      ],
      note: "Pi does not provide MCP by itself. Install the third-party adapter listed in Pi’s official package catalog, then restart Pi; lifecycle checks remain manual.",
    },
  },
  {
    id: "conductor",
    name: "Conductor",
    logoPath: "/client-logos/conductor.ico",
    supportLabel: "Uses agent-specific MCP setup",
    setup: {
      kind: "inherited",
      label: "CONFIGURE THE EFFECTIVE AGENT ENVIRONMENT",
      note: "Claude Code and Codex sessions load their agent-specific Murmur configuration in Conductor. Cursor Composer uses Cursor’s MCP configuration when you open the workspace in Cursor. Verify other harnesses in the home and environment Conductor launches.",
    },
  },
  {
    id: "orca",
    name: "Orca",
    logoPath: "/client-logos/orca.ico",
    supportLabel: "Uses the selected agent’s home",
    setup: {
      kind: "inherited",
      label: "CONFIGURE THE EFFECTIVE AGENT HOME",
      note: "Configure Murmur in the home and environment Orca launches for the selected CLI. The system-default Codex account reads ~/.codex; each extra Orca-managed Codex account has an isolated home and needs its own setup.",
    },
  },
];

export function getClient(id: ClientId): AgentClient {
  for (const client of CLIENTS) {
    if (client.id === id) return client;
  }
  throw new Error(`Unknown client: ${id}`);
}
