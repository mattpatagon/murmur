import { type Dispatch, type ReactElement, type SetStateAction, useState } from "react";

import { ClipboardCopy } from "./clipboard";

type Client = "Claude Code" | "Codex" | "Other MCP client";
const clients: readonly Client[] = ["Claude Code", "Codex", "Other MCP client"];
const commands: Readonly<Record<Client, string>> = {
  "Claude Code":
    "claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp",
  Codex: "codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp",
  "Other MCP client": "https://api.usemurmur.dev/setup/mcp",
};

export default function Setup(): ReactElement {
  const [client, setClient]: [Client, Dispatch<SetStateAction<Client>>] =
    useState<Client>("Claude Code");
  const [feedback, setFeedback]: [string, Dispatch<SetStateAction<string>>] = useState("");
  const [clipboard]: [ClipboardCopy, Dispatch<SetStateAction<ClipboardCopy>>] = useState(
    (): ClipboardCopy =>
      new ClipboardCopy((text: string): Promise<void> => navigator.clipboard.writeText(text)),
  );

  function choose(next: Client): void {
    clipboard.clear();
    setClient(next);
    setFeedback("");
  }

  async function copy(): Promise<void> {
    await clipboard.copy(commands[client], setFeedback);
  }

  return (
    <div className="setup-box">
      <fieldset className="client-selector" aria-label="Choose your MCP client">
        {clients.map(
          (item: Client): ReactElement => (
            <button
              key={item}
              type="button"
              aria-pressed={client === item}
              onClick={(): void => choose(item)}
            >
              {item}
            </button>
          ),
        )}
      </fieldset>
      <div className="command-label">
        <span className="eyebrow">
          {client === "Other MCP client"
            ? "STREAMABLE HTTP · NO AUTHENTICATION"
            : "RUN IN YOUR TERMINAL"}
        </span>
        <button type="button" className="copy-button" onClick={copy}>
          Copy {client === "Other MCP client" ? "URL" : "command"} <span aria-hidden="true">⧉</span>
        </button>
      </div>
      <pre className="command">
        <code>{commands[client]}</code>
      </pre>
      <p className="copy-feedback" role="status">
        {feedback}
      </p>
      <p className="setup-note">
        {client === "Other MCP client"
          ? "Add this URL in your client’s MCP settings using Streamable HTTP, with no authentication."
          : "This adds Murmur’s public, read-only setup connection. It does not create an account or install hooks."}
      </p>
      <noscript>
        <div className="no-js-setup">
          <p>For Codex:</p>
          <pre>
            <code>{commands.Codex}</code>
          </pre>
          <p>For another MCP client, use Streamable HTTP without authentication:</p>
          <pre>
            <code>{commands["Other MCP client"]}</code>
          </pre>
        </div>
      </noscript>
    </div>
  );
}
