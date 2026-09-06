import { type Dispatch, type ReactElement, type SetStateAction, useState } from "react";

import {
  type AgentClient,
  CLIENTS,
  type ClientId,
  type ClientSetup,
  getClient,
  type SetupAction,
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

  async function copy(action: SetupAction): Promise<void> {
    setFeedback("");
    await clipboard.copy(action.value, (message: string): void => {
      const subject: string = action.copyLabel === "configuration" ? "Configuration" : "Command";
      setFeedback(`${subject}: ${message}`);
    });
  }

  function firstSetupValue(candidate: ClientSetup): string {
    if (candidate.kind === "inherited") return "";
    const first: SetupAction | undefined = candidate.actions[0];
    return first === undefined ? "" : first.value;
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
      {setup.kind === "inherited" ? (
        <>
          <div className="command-label">
            <span className="eyebrow">{setup.label}</span>
          </div>
          <div className="inherited-setup">
            <img
              className={`inherited-logo inherited-logo-${client.id}`}
              src={client.logoPath}
              alt=""
              width="48"
              height="48"
            />
            <strong>{client.name} uses the effective MCP configuration for its agent.</strong>
          </div>
        </>
      ) : (
        <div className="setup-actions">
          {setup.actions.map(
            (action: SetupAction): ReactElement => (
              <div className="setup-action" key={action.label}>
                <div className="command-label">
                  <span className="eyebrow">{action.label}</span>
                  <button
                    type="button"
                    className="copy-button"
                    onClick={(): Promise<void> => copy(action)}
                  >
                    Copy {action.copyLabel} <span aria-hidden="true">⧉</span>
                  </button>
                </div>
                <pre className="command">
                  <code>{action.value}</code>
                </pre>
              </div>
            ),
          )}
        </div>
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
            <code>{firstSetupValue(claudeSetup)}</code>
          </pre>
          <p>Codex:</p>
          <pre>
            <code>{firstSetupValue(codexSetup)}</code>
          </pre>
          <p>OpenCode, Cursor, and Pi use the configuration shown in the setup guide.</p>
          <p>Conductor and Orca use the effective MCP configuration of their selected agent.</p>
        </div>
      </noscript>
    </div>
  );
}
