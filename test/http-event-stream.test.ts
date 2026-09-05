import { expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { BoundedHttpClientTransport } from "../src/e2ee/bounded-http-transport.js";
import { deliverHttpEventStream } from "../src/e2ee/http-event-stream.js";

test("HTTP elicitation reaches the client before the original tool response stream closes", async (): Promise<void> => {
  const messages: JSONRPCMessage[] = [];
  let finish: () => void = (): void => undefined;
  const response: Response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"jsonrpc":"2.0","id":5,"method":"elicitation/create","params":{}}\n\n',
          ),
        );
        finish = (): void => {
          controller.enqueue(
            new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
          );
          controller.close();
        };
      },
    }),
  );
  await deliverHttpEventStream(response, 1024, (message: JSONRPCMessage): void => {
    messages.push(message);
    if (messages.length === 1) finish();
  });
  expect(messages).toHaveLength(2);
});

test("stream parser preserves UTF-8, multiline data, CRLF split across chunks, and final events", async (): Promise<void> => {
  const source: string =
    ': comment\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{"label":"café"}}\r\n\r\ndata: {"jsonrpc":"2.0","id":2,"result":{}}';
  const response: Response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const byte of new TextEncoder().encode(source))
          controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  const messages: JSONRPCMessage[] = [];
  await deliverHttpEventStream(response, 1024, (message: JSONRPCMessage): void => {
    messages.push(message);
  });
  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages)).toContain("café");
});

test("invalid, oversized, and empty streams fail closed and release their reader", async (): Promise<void> => {
  const deliver: (message: JSONRPCMessage) => void = (_message: JSONRPCMessage): void => undefined;
  await expect(deliverHttpEventStream(new Response(null), 100, deliver)).rejects.toThrow("empty");
  await expect(
    deliverHttpEventStream(new Response(": heartbeat\n\n"), 100, deliver),
  ).rejects.toThrow("no response");
  await expect(
    deliverHttpEventStream(new Response("data: invalid\n\n"), 100, deliver),
  ).rejects.toThrow("invalid");
  await expect(deliverHttpEventStream(new Response("data: {}\n\n"), 100, deliver)).rejects.toThrow(
    "invalid",
  );
  await expect(deliverHttpEventStream(new Response("x".repeat(101)), 100, deliver)).rejects.toThrow(
    "size limit",
  );
  expect(
    (): BoundedHttpClientTransport =>
      new BoundedHttpClientTransport(new URL("http://localhost"), new Headers(), 150_001),
  ).toThrow("deadline");
});
