import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { logSafeError } from "../safe-errors.js";
import { oauthError } from "./connector-oauth-protocol.js";
import { OAUTH_TOKEN_PATH } from "./http-config.js";
import {
  cancelNodeResponse,
  NodeHttpLifecycle,
  ResponseLifetimeIncomingMessage,
} from "./node-http-lifecycle.js";
import {
  HTTP_HEADER_BYTES,
  IngressByteBudget,
  type IngressFailure,
  type NodeRequestMetadata,
  nodeRequestMetadata,
  StagedNodeBody,
} from "./node-http-request.js";
import { pumpNodeResponse } from "./node-http-response.js";

const MAX_OBSERVED_CONNECTIONS: number = 256;
const MAX_ACTIVE_TRANSPORT_REQUESTS: number = 256;
const NATIVE_IDLE_TIMEOUT_MS: number = 60_000;
const INPUT_LIFETIME_MS: number = 15_000;
const ERROR_DELIVERY_MS: number = 1_000;
const SHUTDOWN_MS: number = 2_000;

export type NodeHttpServerOptions = {
  readonly hostname: string;
  readonly port: number;
  readonly maxRequestBytes: number;
  readonly fetch: (request: Request) => Promise<Response>;
};

export type NodeHttpServer = {
  readonly port: number;
  stop(closeActiveConnections: boolean): Promise<void>;
};

function ingressFailureResponse(failure: IngressFailure, path: string | null = null): Response {
  if (failure === "too_large" && path === OAUTH_TOKEN_PATH) {
    return oauthError(400, "invalid_request", "Token request is invalid");
  }
  if (failure === "capacity") {
    return Response.json(
      { error: "HTTP ingress capacity reached" },
      {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "1" },
      },
    );
  }
  return Response.json(
    {
      error:
        failure === "too_large" ? "HTTP request body exceeds its limit" : "Invalid HTTP request",
    },
    {
      status: failure === "too_large" ? 413 : 400,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function finishResponse(
  response: Response,
  outgoing: ServerResponse,
  lifecycle: NodeHttpLifecycle,
): Promise<void> {
  await pumpNodeResponse(response, outgoing, lifecycle.peerSignal);
  if (lifecycle.peerSignal.aborted || outgoing.destroyed)
    throw new Error("HTTP response interrupted");
  lifecycle.completeOutput();
  await new Promise<void>((resolve: () => void): void => {
    outgoing.end(resolve);
  });
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: NodeHttpServerOptions,
  budget: IngressByteBudget,
  active: Set<NodeHttpLifecycle>,
): Promise<void> {
  if (incoming.socket.destroyed) return;
  const lifecycle: NodeHttpLifecycle = new NodeHttpLifecycle(incoming, outgoing);
  let staged: StagedNodeBody | null = null;
  let responded: boolean = false;
  let responseTask: Promise<void> | null = null;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectionTimer: ReturnType<typeof setTimeout> | null = null;
  const endInput: () => void = (): void => {
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = null;
    if (staged !== null) staged.end();
  };
  const consume: (chunk: unknown) => void = (chunk: unknown): void => {
    if (staged !== null) staged.push(chunk);
  };
  const abortInput: () => void = (): void => {
    if (staged !== null) staged.stop();
  };
  const reject: (response: Response) => void = (response: Response): void => {
    if (responded) return;
    responded = true;
    lifecycle.abortRequest();
    if (staged !== null) staged.stop();
    response.headers.set("connection", "close");
    rejectionTimer = setTimeout((): void => lifecycle.close(), ERROR_DELIVERY_MS);
    responseTask = finishResponse(response, outgoing, lifecycle).catch((error: unknown): void => {
      if (!lifecycle.peerSignal.aborted)
        logSafeError("Murmur HTTP rejection delivery failed", error);
      lifecycle.close();
    });
  };
  const admitted: boolean = active.size < MAX_ACTIVE_TRANSPORT_REQUESTS;
  if (admitted) active.add(lifecycle);
  try {
    if (!admitted) {
      reject(ingressFailureResponse("capacity"));
      return;
    }
    let metadata: NodeRequestMetadata;
    try {
      metadata = nodeRequestMetadata(incoming, options.maxRequestBytes);
    } catch (_error: unknown) {
      reject(ingressFailureResponse("invalid"));
      return;
    }
    if (metadata.declaredBytes !== null && metadata.declaredBytes > metadata.maximumBodyBytes) {
      reject(ingressFailureResponse("too_large", metadata.url.pathname));
      return;
    }
    staged = new StagedNodeBody(
      budget,
      metadata.maximumBodyBytes,
      (failure: IngressFailure): void => {
        reject(ingressFailureResponse(failure, metadata.url.pathname));
      },
      (): void => {
        if (
          !responded &&
          !lifecycle.requestSignal.aborted &&
          metadata.headers.get("expect") === "100-continue"
        ) {
          outgoing.writeContinue();
        }
      },
    );
    incoming.on("data", consume);
    incoming.once("end", endInput);
    lifecycle.peerSignal.addEventListener("abort", abortInput, { once: true });
    // read(0) activates the native data callback synchronously, without consuming application bytes.
    // Waiting for the next resume tick would leave Bun's Windows-only paused buffer active.
    incoming.read(0);
    if (responded || lifecycle.requestSignal.aborted) return;
    if (metadata.hasBody && !incoming.readableEnded) {
      inputTimer = setTimeout((): void => {
        reject(
          Response.json(
            { error: "HTTP request body deadline exceeded" },
            {
              status: 408,
              headers: { "cache-control": "no-store" },
            },
          ),
        );
      }, INPUT_LIFETIME_MS);
    }
    const request: Request = new Request(metadata.url, {
      method: metadata.method,
      headers: metadata.headers,
      signal: lifecycle.requestSignal,
      ...(metadata.hasBody ? { body: staged.body } : {}),
    });
    const response: Response = await options.fetch(request);
    if (responded || lifecycle.requestSignal.aborted) {
      await cancelNodeResponse(response);
      return;
    }
    responded = true;
    // An unread/rejected upload cannot be reused as an unbounded drain or a pipelined request.
    if (metadata.hasBody && !incoming.readableEnded) response.headers.set("connection", "close");
    responseTask = finishResponse(response, outgoing, lifecycle);
    await responseTask;
  } catch (error: unknown) {
    if (!lifecycle.peerSignal.aborted) logSafeError("Murmur HTTP transport failed", error);
    if (!responded && !outgoing.headersSent && !lifecycle.peerSignal.aborted) {
      reject(
        Response.json(
          { error: "Internal server error" },
          {
            status: 500,
            headers: { "cache-control": "no-store" },
          },
        ),
      );
    } else lifecycle.close();
  } finally {
    if (responseTask !== null) {
      await responseTask.catch((_error: unknown): void => lifecycle.close());
    }
    if (inputTimer !== null) clearTimeout(inputTimer);
    if (rejectionTimer !== null) clearTimeout(rejectionTimer);
    incoming.off("data", consume);
    incoming.off("end", endInput);
    lifecycle.peerSignal.removeEventListener("abort", abortInput);
    if (staged !== null) staged.stop();
    active.delete(lifecycle);
    lifecycle.dispose();
  }
}

async function listen(server: Server, hostname: string, port: number): Promise<number> {
  await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    const failed: (error: Error) => void = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen({ host: hostname, port }, (): void => {
      server.off("error", failed);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    throw new Error("The HTTP server did not bind a TCP port");
  }
  return address.port;
}

export async function startNodeHttpServer(options: NodeHttpServerOptions): Promise<NodeHttpServer> {
  if (
    options.hostname === "" ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535 ||
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes < 1
  )
    throw new Error("Invalid HTTP listener configuration");
  const budget: IngressByteBudget = new IngressByteBudget();
  const active: Set<NodeHttpLifecycle> = new Set<NodeHttpLifecycle>();
  const sockets: Set<Socket> = new Set<Socket>();
  let stopping: Promise<void> | null = null;
  const dispatch: (incoming: IncomingMessage, outgoing: ServerResponse) => void = (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): void => {
    if (stopping !== null) {
      outgoing.destroy();
      return;
    }
    void handleRequest(incoming, outgoing, options, budget, active).catch(
      (error: unknown): void => {
        logSafeError("Murmur HTTP cleanup failed", error);
        outgoing.destroy();
      },
    );
  };
  const server: Server = createServer(
    {
      IncomingMessage: ResponseLifetimeIncomingMessage,
      maxHeaderSize: HTTP_HEADER_BYTES,
      requireHostHeader: true,
    },
    dispatch,
  );
  server.on("checkContinue", dispatch);
  server.setTimeout(NATIVE_IDLE_TIMEOUT_MS);
  server.on("error", (error: Error): void => logSafeError("Murmur HTTP listener failed", error));
  server.on("clientError", (_error: Error, socket: Socket): void => {
    socket.destroy();
  });
  server.on("connect", (_request: IncomingMessage, socket: Socket): void => {
    socket.destroy();
  });
  server.on("upgrade", (_request: IncomingMessage, socket: Socket): void => {
    socket.destroy();
  });
  server.on("connection", (socket: Socket): void => {
    // Bun can omit close after completed keep-alive requests; the public address then disappears.
    for (const observed of sockets) {
      if (observed.destroyed || observed.localPort === undefined) sockets.delete(observed);
    }
    if (sockets.size >= MAX_OBSERVED_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", (): void => {
      sockets.delete(socket);
    });
    socket.on("error", (error: Error): void => logSafeError("Murmur HTTP socket failed", error));
  });
  let boundPort: number;
  try {
    boundPort = await listen(server, options.hostname, options.port);
  } catch (error: unknown) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  return {
    port: boundPort,
    stop: (closeActiveConnections: boolean): Promise<void> => {
      if (stopping !== null) return stopping;
      stopping = new Promise<void>((resolve: () => void): void => {
        const finish: () => void = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          for (const lifecycle of active) lifecycle.close();
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
          resolve();
        }, SHUTDOWN_MS);
        server.close(finish);
        if (closeActiveConnections) {
          for (const lifecycle of active) lifecycle.close();
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
        }
      });
      return stopping;
    },
  };
}
