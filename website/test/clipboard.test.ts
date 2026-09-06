import { expect, test } from "bun:test";

import { ClipboardCopy } from "../src/components/clipboard";

test("copy reports success only after the exact command reaches the clipboard", async (): Promise<void> => {
  const writes: string[] = [];
  const messages: string[] = [];
  const clipboard: ClipboardCopy = new ClipboardCopy(async (value: string): Promise<void> => {
    writes.push(value);
  });
  await clipboard.copy("codex command", (message: string): void => {
    messages.push(message);
  });
  expect(writes).toEqual(["codex command"]);
  expect(messages).toEqual(["Copied. Paste it into your terminal or MCP configuration."]);
});

test("clipboard rejection offers manual copy without exposing the exception", async (): Promise<void> => {
  const messages: string[] = [];
  const clipboard: ClipboardCopy = new ClipboardCopy(async (): Promise<void> => {
    throw new Error("private clipboard diagnostic");
  });
  await clipboard.copy("command", (message: string): void => {
    messages.push(message);
  });
  expect(messages).toEqual(["Select and copy the command below."]);
});

test("changing client invalidates feedback from an outstanding clipboard write", async (): Promise<void> => {
  const pending: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  const messages: string[] = [];
  const clipboard: ClipboardCopy = new ClipboardCopy((): Promise<void> => pending.promise);
  const copying: Promise<void> = clipboard.copy("previous client", (message: string): void => {
    messages.push(message);
  });
  clipboard.clear();
  pending.resolve();
  await copying;
  expect(messages).toEqual([]);
});

test("an obsolete failed copy cannot replace a newer successful result", async (): Promise<void> => {
  const pending: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  const messages: string[] = [];
  let writes: number = 0;
  const clipboard: ClipboardCopy = new ClipboardCopy((): Promise<void> => {
    writes += 1;
    return writes === 1 ? pending.promise : Promise.resolve();
  });
  const report: (message: string) => void = (message: string): void => {
    messages.push(message);
  };
  const first: Promise<void> = clipboard.copy("first command", report);
  await clipboard.copy("second command", report);
  pending.reject(new Error("outdated request"));
  await first;
  expect(messages).toEqual(["Copied. Paste it into your terminal or MCP configuration."]);
});
