import { expect, test } from "bun:test";
import { Socket } from "node:net";

import { type NodeHttpServer, startNodeHttpServer } from "../src/http/node-http-server.js";

type Barrier = { readonly promise: Promise<void>; release(): void };

function barrier(): Barrier {
  let release: () => void = (): void => undefined;
  const promise: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  return { promise, release };
}

function readResponse(client: Socket, contains: string = "\r\n\r\n"): Promise<string> {
  return new Promise<string>(
    (resolve: (value: string) => void, reject: (error: Error) => void): void => {
      let received: string = "";
      const deadline: ReturnType<typeof setTimeout> = setTimeout(
        (): void => reject(new Error("Test response deadline")),
        2_000,
      );
      client.on("data", (chunk: Buffer): void => {
        received += chunk.toString("latin1");
        if (received.includes(contains)) {
          clearTimeout(deadline);
          resolve(received);
        }
      });
      client.once("error", (error: Error): void => {
        clearTimeout(deadline);
        reject(error);
      });
      client.once("end", (): void => {
        clearTimeout(deadline);
        resolve(received);
      });
    },
  );
}

async function connect(client: Socket, port: number): Promise<void> {
  await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    client.once("error", reject);
    client.connect({ host: "127.0.0.1", port }, (): void => {
      client.off("error", reject);
      resolve();
    });
  });
}

test("listener preserves response metadata and supports immediate asynchronous startup and stop", async (): Promise<void> => {
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 1_024,
    fetch: async (request: Request): Promise<Response> =>
      new Response(request.method === "HEAD" ? null : "ready", {
        status: 201,
        headers: { "x-test": "preserved" },
      }),
  });
  try {
    const response: Response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("preserved");
    expect(await response.text()).toBe("ready");
    const head: Response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2_000),
    });
    expect(head.status).toBe(201);
    expect(await head.text()).toBe("");
  } finally {
    await server.stop(true);
    await server.stop(true);
  }
});

test("incomplete unauthorized upload receives its response without application parsing", async (): Promise<void> => {
  const entered: Barrier = barrier();
  const authorize: Barrier = barrier();
  let parsed: boolean = false;
  let bodyUsedAtEntry: boolean = true;
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      bodyUsedAtEntry = request.bodyUsed;
      entered.release();
      await authorize.promise;
      if (request.headers.get("authorization") === null)
        return new Response("denied", { status: 401 });
      parsed = true;
      return new Response(await request.text());
    },
  });
  const client: Socket = new Socket();
  try {
    const response: Promise<string> = readResponse(client, "denied");
    await connect(client, server.port);
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 32\r\n\r\npartial`,
    );
    await entered.promise;
    expect(bodyUsedAtEntry).toBe(false);
    authorize.release();
    expect((await response).startsWith("HTTP/1.1 401")).toBe(true);
    expect(parsed).toBe(false);
  } finally {
    authorize.release();
    client.destroy();
    await server.stop(true);
  }
});

test("chunked overflow aborts waiting authorization and returns 413 without parsing", async (): Promise<void> => {
  const entered: Barrier = barrier();
  const authorize: Barrier = barrier();
  const settled: Barrier = barrier();
  let parsed: boolean = false;
  let aborted: boolean = false;
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      entered.release();
      await authorize.promise;
      aborted = request.signal.aborted;
      if (aborted) {
        settled.release();
        return new Response(null, { status: 204 });
      }
      parsed = true;
      const body: string = await request.text();
      settled.release();
      return new Response(body);
    },
  });
  const client: Socket = new Socket();
  try {
    const response: Promise<string> = readResponse(client);
    await connect(client, server.port);
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    await entered.promise;
    client.write(`41\r\n${"a".repeat(65)}\r\n`);
    expect((await response).startsWith("HTTP/1.1 413")).toBe(true);
    authorize.release();
    await settled.promise;
    expect(aborted).toBe(true);
    expect(parsed).toBe(false);
  } finally {
    authorize.release();
    client.destroy();
    await server.stop(true);
  }
});

test("declared excess is refused before dispatch and valid ingress is delivered unchanged", async (): Promise<void> => {
  let dispatched: number = 0;
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      dispatched += 1;
      return new Response(await request.text());
    },
  });
  try {
    const excessive: Response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      body: "a".repeat(65),
      signal: AbortSignal.timeout(2_000),
    });
    expect(excessive.status).toBe(413);
    await excessive.text();
    expect(dispatched).toBe(0);
    const valid: Response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    expect(await valid.text()).toBe("{}");
    expect(dispatched).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("bind failure rejects startup and force-stop aborts a pending application Request", async (): Promise<void> => {
  const entered: Barrier = barrier();
  const aborted: Barrier = barrier();
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      request.signal.addEventListener("abort", aborted.release, { once: true });
      entered.release();
      await aborted.promise;
      return new Response(null, { status: 204 });
    },
  });
  const client: Socket = new Socket();
  client.on("error", (_error: Error): void => undefined);
  try {
    await expect(
      startNodeHttpServer({
        hostname: "127.0.0.1",
        port: server.port,
        maxRequestBytes: 64,
        fetch: async (): Promise<Response> => new Response(),
      }),
    ).rejects.toThrow();
    await connect(client, server.port);
    client.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    await entered.promise;
    await server.stop(true);
    await aborted.promise;
  } finally {
    aborted.release();
    client.destroy();
    await server.stop(true);
  }
});

test("Expect clients are not prompted to upload before an authentication rejection", async (): Promise<void> => {
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      expect(request.bodyUsed).toBe(false);
      return new Response("denied", { status: 401 });
    },
  });
  const client: Socket = new Socket();
  try {
    const response: Promise<string> = readResponse(client, "denied");
    await connect(client, server.port);
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`,
    );
    const text: string = await response;
    expect(text.startsWith("HTTP/1.1 401")).toBe(true);
    expect(text.includes("100 Continue")).toBe(false);
  } finally {
    client.destroy();
    await server.stop(true);
  }
});

test("Expect clients receive Continue on body demand and the final response after upload", async (): Promise<void> => {
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      expect(await request.text()).toBe("{}");
      return new Response("uploaded");
    },
  });
  const client: Socket = new Socket();
  let continued: boolean = false;
  try {
    const response: Promise<string> = readResponse(client, "uploaded");
    client.on("data", (chunk: Buffer): void => {
      if (!continued && chunk.toString("latin1").includes("100 Continue")) {
        continued = true;
        client.write("{}");
      }
    });
    await connect(client, server.port);
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`,
    );
    expect((await response).includes("HTTP/1.1 200")).toBe(true);
    expect(continued).toBe(true);
  } finally {
    client.destroy();
    await server.stop(true);
  }
});

test("completed input preserves peer cancellation while the response source is still active", async (): Promise<void> => {
  const aborted: Barrier = barrier();
  const cancelled: Barrier = barrier();
  let abortCount: number = 0;
  let cancelCount: number = 0;
  const server: NodeHttpServer = await startNodeHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 64,
    fetch: async (request: Request): Promise<Response> => {
      request.signal.addEventListener(
        "abort",
        (): void => {
          abortCount += 1;
          aborted.release();
        },
        { once: true },
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array>): void {
            controller.enqueue(new TextEncoder().encode("prefix"));
          },
          cancel: (): void => {
            cancelCount += 1;
            cancelled.release();
          },
        }),
      );
    },
  });
  const client: Socket = new Socket();
  try {
    const response: Promise<string> = readResponse(client, "prefix");
    await connect(client, server.port);
    client.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    await response;
    client.destroy();
    await aborted.promise;
    await cancelled.promise;
    expect(abortCount).toBe(1);
    expect(cancelCount).toBe(1);
  } finally {
    client.destroy();
    aborted.release();
    cancelled.release();
    await server.stop(true);
  }
});
