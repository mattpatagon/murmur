import { type Dispatch, type ReactElement, type SetStateAction, useState } from "react";

type DemoStep = {
  readonly action: string;
  readonly status: string;
  readonly detail: string;
};
const steps: readonly DemoStep[] = [
  {
    action: "Send the handoff",
    status: "Ready to send",
    detail: "Claude has context that Codex needs.",
  },
  {
    action: "Bring Codex back",
    status: "Stored in the inbox",
    detail: "Codex is away. The message is already saved.",
  },
  {
    action: "Replay the handoff",
    status: "Read by Codex",
    detail: "Codex returns, reads its inbox, and picks up the work.",
  },
];

export default function HandoffDemo(): ReactElement {
  const [step, setStep]: [number, Dispatch<SetStateAction<number>>] = useState(0);
  const current: DemoStep | undefined = steps[step];
  if (current === undefined) throw new Error("Unknown demo step");

  function advance(): void {
    setStep((previous: number): number => (previous + 1) % steps.length);
  }

  return (
    <section className="handoff" aria-label="Interactive example of a durable agent handoff">
      <div className="demo-top">
        <span className="eyebrow">A HANDOFF, WITHOUT THE COPY-PASTE</span>
        <span className="demo-label">DEMO</span>
      </div>
      <div className="agent-line">
        <span className="agent-avatar">C</span>
        <div>
          <strong>Claude Code</strong>
          <span className="mono">feature / authentication</span>
        </div>
        <span className="agent-state">● Working</span>
      </div>
      <div className="message-bubble">
        <span className="message-direction">TO CODEX</span>
        <p>
          Auth endpoint is ready.
          <br />
          You can wire up the login screen.
        </p>
        <span className="mono">acme / app · handoff #024</span>
      </div>
      <div className="delivery-route">
        <span className="route-dots" aria-hidden="true" />
        <div className={step > 0 ? "inbox-node is-stored" : "inbox-node"}>
          <span aria-hidden="true">▤</span> Durable inbox{" "}
          <span aria-hidden="true">{step > 0 ? "✓" : "↓"}</span>
        </div>
        <span className="route-dots" aria-hidden="true" />
      </div>
      <div className="agent-line recipient">
        <span className="agent-avatar">X</span>
        <div>
          <strong>Codex</strong>
          <span className="mono">feature / login-screen</span>
        </div>
        <span className="agent-state">{step === 2 ? "● Back online" : "○ Away"}</span>
      </div>
      <div className="demo-status" aria-live="polite" aria-atomic="true">
        <strong>{current.status}</strong>
        <p>{current.detail}</p>
      </div>
      <div className="demo-controls">
        <span className="mono">
          0{step + 1} <span className="dim">/ 03</span>
        </span>
        <button type="button" onClick={advance}>
          {current.action} <span aria-hidden="true">↗</span>
        </button>
      </div>
      <noscript>
        <p className="demo-noscript">
          Messages are saved while a recipient is away and read when it returns. Enable JavaScript
          to step through the demo.
        </p>
      </noscript>
    </section>
  );
}
