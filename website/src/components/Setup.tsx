import { type Dispatch, type ReactElement, type SetStateAction, useState } from "react";

import {
  type AgentClient,
  CLIENTS,
  type ClientId,
  type ClientSetup,
  getClient,
} from "../data/clients";
import { ClipboardCopy } from "./clipboard";

export default function Setup(): ReactElement {
  const [clientId, setClientId]: [ClientId, Dispatch<SetStateAction<ClientId>>] =
    useState<ClientId>("claude-code");
  const [feedback, setFeedback]: [string, Dispatch<SetStateAction<string>>] = useState("");
  const [clipboard]: [ClipboardCopy, Dispatch<SetStateAction<ClipboardCopy>>] = useState(
    (): ClipboardCopy =>
      new ClipboardCopy((text: string): Promise<void> => navigator.clipboard.writeText(text)),
  );
  const client: AgentClient = getClient(clientId);
  const setup: ClientSetup = client.setup;
  const claudeSetup: ClientSetup = getClient("claude-code").setup;
  const codexSetup: ClientSetup = getClient("codex").setup;

  function choose(next: ClientId): void {
    clipboard.clear();
    setClientId(next);
    setFeedback("");
  }

  async function copy(): Promise<void> {
    if (setup.kind === "inherited") return;
    await clipboard.copy(setup.value, setFeedback);
  }

  return (
    <div className="setup-box">
      <fieldset className="client-selector" aria-label="Choose your MCP client">
        {CLIENTS.map(
          (item: AgentClient): ReactElement => (
            <button
              key={item.id}
              type="button"
              aria-pressed={clientId === item.id}
              onClick={(): void => choose(item.id)}
            >
              <span className={`setup-client-logo setup-client-logo-${item.id}`} aria-hidden="true">
                <img src={item.logoPath} alt="" width="34" height="34" />
              </span>
              <span>{item.name}</span>
            </button>
          ),
        )}
      </fieldset>
      <div className="command-label">
        <span className="eyebrow">{setup.label}</span>
        {setup.kind === "inherited" ? null : (
          <button type="button" className="copy-button" onClick={copy}>
            Copy {setup.copyLabel} <span aria-hidden="true">⧉</span>
          </button>
        )}
      </div>
      {setup.kind === "inherited" ? (
        <div className="inherited-setup">
          <img
            className={`inherited-logo inherited-logo-${client.id}`}
            src={client.logoPath}
            alt=""
            width="48"
            height="48"
          />
          <strong>{client.name} uses your launched agent’s connection.</strong>
        </div>
      ) : (
        <pre className="command">
          <code>{setup.value}</code>
        </pre>
      )}
      <p className="copy-feedback" role="status">
        {feedback}
      </p>
      <p className="setup-tier">{client.supportLabel}</p>
      <p className="setup-note">{setup.note}</p>
      <noscript>
        <div className="no-js-setup">
          <p>Claude Code:</p>
          <pre>
            <code>{claudeSetup.kind === "command" ? claudeSetup.value : ""}</code>
          </pre>
          <p>Codex:</p>
          <pre>
            <code>{codexSetup.kind === "command" ? codexSetup.value : ""}</code>
          </pre>
          <p>OpenCode, Cursor, and Pi use the configuration shown in the setup guide.</p>
          <p>Conductor and Orca inherit the connection of the agent they launch.</p>
        </div>
      </noscript>
    </div>
  );
}
