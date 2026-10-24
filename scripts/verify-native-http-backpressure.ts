import { Socket } from "node:net";
import process from "node:process";

import { type NodeHttpServer, startNodeHttpServer } from "../src/http/node-http-server.js";

const CLIENT_COUNT: number = 4;
const CHUNK_BYTES: number = 32 * 1024;
const RESPONSE_BYTES: number = 64 * 1024 * 1024;
const MAXIMUM_PRODUCED_BYTES: number = 16 * 1024 * 1024;
const MAXIMUM_RSS_GROWTH: number = 128 * 1024 * 1024;
const OBSERVATION_MS: number = 2_000;

async function connect(client: Socket, port: number): Promise<void> {
  await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    const deadline: ReturnType<typeof setTimeout> = setTimeout(
      (): void => reject(new Error("Slow-reader connection deadline exceeded")),
      2_000,
    );
    client.once("error", (error: Error): void => {
      clearTimeout(deadline);
      reject(error);
    });
    client.connect({ host: "127.0.0.1", port }, (): void => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

async function verifyBackpressure(): Promise<void> {
  let producedBytes: number = 0;
  let canceledResponses: number = 0;
  let openedResponses: number = 0;
  let clientFailure: boolean = false;
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 1024,
    fetch: async (): Promise<Response> => {
      openedResponses += 1;
      let remaining: number = RESPONSE_BYTES;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
            if (remaining === 0) {
              controller.close();
              return;
            }
            remaining -= CHUNK_BYTES;
            producedBytes += CHUNK_BYTES;
            controller.enqueue(new Uint8Array(CHUNK_BYTES));
          },
          cancel(): void {
            canceledResponses += 1;
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    },
  });
  const clients: Socket[] = [];
  const initialRss: number = process.memoryUsage().rss;
  let peakRss: number = initialRss;
  try {
    for (let index: number = 0; index < CLIENT_COUNT; index += 1) {
      const client: Socket = new Socket();
      clients.push(client);
      client.on("error", (_error: Error): void => {
        clientFailure = true;
      });
      await connect(client, server.port);
      client.pause();
      client.write(`GET /memory-probe HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    }
    const deadline: number = performance.now() + OBSERVATION_MS;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 25);
      });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (producedBytes > MAXIMUM_PRODUCED_BYTES || peakRss - initialRss > MAXIMUM_RSS_GROWTH)
        throw new Error("Slow readers exceeded the native output memory budget");
    }
    if (
      clientFailure ||
      openedResponses !== CLIENT_COUNT ||
      producedBytes < CLIENT_COUNT * CHUNK_BYTES
    )
      throw new Error("Slow-reader probes did not reach every response source");
  } finally {
    for (const client of clients) client.destroy();
    await server.stop(true);
  }
  if (canceledResponses !== CLIENT_COUNT)
    throw new Error("Slow-reader shutdown did not cancel every response source");
  process.stdout.write(
    `${JSON.stringify({
      check: "native-http-slow-reader",
      bun: Bun.version,
      clients: openedResponses,
      producedBytes,
      rssGrowthBytes: peakRss - initialRss,
      canceledResponses,
    })}\n`,
  );
}

await verifyBackpressure();
