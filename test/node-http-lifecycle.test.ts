import { expect, test } from "bun:test";
import { Socket } from "node:net";

import { ResponseLifetimeIncomingMessage } from "../src/http/node-http-lifecycle.js";

test("response release does not turn an incomplete upload into a forced socket reset", (): void => {
  const socket: Socket = new Socket();
  const incoming: ResponseLifetimeIncomingMessage = new ResponseLifetimeIncomingMessage(socket);
  let aborted: boolean = false;
  incoming.on("aborted", (): void => {
    aborted = true;
  });
  try {
    expect(incoming.complete).toBe(false);
    expect(incoming.readableEnded).toBe(false);
    incoming.releaseAfterResponse();
    incoming.releaseAfterResponse();
    expect(incoming.destroyed).toBe(false);
    expect(aborted).toBe(false);
  } finally {
    incoming.destroy();
    socket.destroy();
  }
});

test("completed input destruction waits for response settlement and then releases normally", async (): Promise<void> => {
  const socket: Socket = new Socket();
  const incoming: ResponseLifetimeIncomingMessage = new ResponseLifetimeIncomingMessage(socket);
  try {
    incoming.complete = true;
    const ended: Promise<void> = new Promise<void>((resolve: () => void): void => {
      incoming.once("end", resolve);
    });
    incoming.push(null);
    incoming.resume();
    await ended;
    expect(incoming.readableEnded).toBe(true);
    expect(incoming.destroyed).toBe(false);
    incoming.releaseAfterResponse();
    expect(incoming.destroyed).toBe(true);
  } finally {
    incoming.releaseAfterResponse();
    incoming.destroy();
    socket.destroy();
  }
});

test("an explicit incomplete-input abort still destroys immediately", async (): Promise<void> => {
  const socket: Socket = new Socket();
  const incoming: ResponseLifetimeIncomingMessage = new ResponseLifetimeIncomingMessage(socket);
  const aborted: Promise<void> = new Promise<void>((resolve: () => void): void => {
    incoming.once("aborted", resolve);
  });
  try {
    incoming.destroy();
    expect(incoming.destroyed).toBe(true);
    await aborted;
  } finally {
    socket.destroy();
  }
});
