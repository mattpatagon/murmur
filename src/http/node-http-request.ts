import type { IncomingMessage } from "node:http";

import {
  MCP_PATH,
  OAUTH_TOKEN_PATH,
  PUBLIC_SETUP_PATH,
  TENANT_REGISTRATION_PATH,
} from "./http-config.js";

export const HTTP_INGRESS_STAGING_BYTES: number = 8 * 1024 * 1024;
export const HTTP_HEADER_BYTES: number = 16 * 1024;
const BLOCK_BYTES: number = 4_096;
const HEADER_NAME: RegExp = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const METHOD: RegExp = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/u;
const SINGLE_HEADERS: ReadonlySet<string> = new Set<string>([
  "authorization",
  "content-length",
  "content-type",
  "host",
  "mcp-session-id",
  "origin",
  "transfer-encoding",
  "x-murmur-branch",
  "x-murmur-client",
  "x-murmur-repository",
]);

export type IngressFailure = "invalid" | "too_large" | "capacity";
type Block = { readonly bytes: Uint8Array; readonly release: () => void; length: number };

export class IngressByteBudget {
  private used: number = 0;

  public constructor(private readonly maximum: number = HTTP_INGRESS_STAGING_BYTES) {
    if (!Number.isSafeInteger(maximum) || maximum < BLOCK_BYTES) {
      throw new Error("Invalid HTTP ingress staging budget");
    }
  }

  public get reservedBytes(): number {
    return this.used;
  }

  public reserveBlock(): (() => void) | null {
    if (this.used > this.maximum - BLOCK_BYTES) return null;
    this.used += BLOCK_BYTES;
    let released: boolean = false;
    return (): void => {
      if (released) return;
      released = true;
      this.used -= BLOCK_BYTES;
    };
  }
}

/** Opaque staging is eager; application body consumption and parsing remain demand-driven. */
export class StagedNodeBody {
  public readonly body: ReadableStream<Uint8Array>;
  private readonly queue: Block[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private demand: boolean = false;
  private ended: boolean = false;
  private stopped: boolean = false;
  private accepted: number = 0;
  private failure: IngressFailure | null = null;
  private started: boolean = false;

  public constructor(
    private readonly budget: IngressByteBudget,
    private readonly maximum: number,
    private readonly onFailure: (failure: IngressFailure) => void,
    private readonly onFirstDemand: () => void = (): void => undefined,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid HTTP body limit");
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
          this.controller = controller;
        },
        pull: (): void => {
          if (!this.started) {
            this.started = true;
            this.onFirstDemand();
          }
          this.demand = true;
          this.drain();
        },
        cancel: (): void => {
          this.stop(false);
        },
      },
      { highWaterMark: 0 },
    );
  }

  public get rejection(): IngressFailure | null {
    return this.failure;
  }

  public push(value: unknown): void {
    if (this.stopped) return;
    if (!(value instanceof Uint8Array)) {
      this.reject("invalid");
      return;
    }
    if (value.byteLength > this.maximum - this.accepted) {
      this.reject("too_large");
      return;
    }
    this.accepted += value.byteLength;
    let offset: number = 0;
    while (offset < value.byteLength && !this.stopped) {
      let tail: Block | undefined = this.queue[this.queue.length - 1];
      if (tail === undefined || tail.length === BLOCK_BYTES) {
        const release: (() => void) | null = this.budget.reserveBlock();
        if (release === null) {
          this.reject("capacity");
          return;
        }
        tail = { bytes: new Uint8Array(BLOCK_BYTES), length: 0, release };
        this.queue.push(tail);
      }
      const count: number = Math.min(BLOCK_BYTES - tail.length, value.byteLength - offset);
      tail.bytes.set(value.subarray(offset, offset + count), tail.length);
      tail.length += count;
      offset += count;
    }
    this.drain();
  }

  public end(): void {
    this.ended = true;
    this.drain();
  }

  public stop(closeBody: boolean = true): void {
    if (this.stopped) return;
    this.stopped = true;
    this.releaseBlocks();
    if (closeBody && this.controller !== null) this.controller.close();
  }

  private reject(failure: IngressFailure): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failure = failure;
    this.releaseBlocks();
    if (this.controller !== null) this.controller.error(new Error("HTTP request body rejected"));
    this.onFailure(failure);
  }

  private releaseBlocks(): void {
    for (const block of this.queue) block.release();
    this.queue.length = 0;
  }

  private drain(): void {
    if (this.stopped || !this.demand || this.controller === null) return;
    const block: Block | undefined = this.queue.shift();
    if (block !== undefined) {
      this.demand = false;
      block.release();
      this.controller.enqueue(block.bytes.subarray(0, block.length));
    } else if (this.ended) {
      this.stopped = true;
      this.controller.close();
    }
  }
}

export type NodeRequestMetadata = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly maximumBodyBytes: number;
  readonly declaredBytes: number | null;
  readonly hasBody: boolean;
};

function requestHeaders(raw: readonly string[]): Headers {
  if (raw.length % 2 !== 0) throw new Error("Invalid HTTP headers");
  let bytes: number = 0;
  const seen: Set<string> = new Set<string>();
  const headers: Headers = new Headers();
  for (let index: number = 0; index < raw.length; index += 2) {
    const name: string | undefined = raw[index];
    const value: string | undefined = raw[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !HEADER_NAME.test(name) ||
      /[\r\n\0]/u.test(value)
    ) {
      throw new Error("Invalid HTTP headers");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > HTTP_HEADER_BYTES) throw new Error("HTTP headers exceed their limit");
    const key: string = name.toLowerCase();
    if (seen.has(key) && SINGLE_HEADERS.has(key)) throw new Error("Ambiguous HTTP headers");
    seen.add(key);
    headers.append(name, value);
  }
  return headers;
}

function bodyMaximum(path: string, method: string, configuredMaximum: number): number {
  if (method === "GET" || method === "HEAD") return 0;
  if (path === MCP_PATH) return configuredMaximum;
  if (path === TENANT_REGISTRATION_PATH) return Math.min(configuredMaximum, 4_096);
  if (path === OAUTH_TOKEN_PATH || path === PUBLIC_SETUP_PATH) return 8_192;
  return Math.min(configuredMaximum, 8_192);
}

function invalidTarget(target: string): boolean {
  for (const character of target) {
    const code: number = character.charCodeAt(0);
    if (code <= 32 || code === 127 || character === "\\" || character === "#") return true;
  }
  return false;
}

export function nodeRequestMetadata(
  incoming: Pick<IncomingMessage, "method" | "url" | "rawHeaders">,
  configuredMaximum: number,
): NodeRequestMetadata {
  const method: string | undefined = incoming.method;
  const target: string | undefined = incoming.url;
  if (
    method === undefined ||
    !METHOD.test(method) ||
    ["CONNECT", "TRACE", "TRACK"].includes(method) ||
    target === undefined ||
    target.length > HTTP_HEADER_BYTES ||
    !target.startsWith("/") ||
    invalidTarget(target)
  )
    throw new Error("Invalid HTTP request metadata");
  const headers: Headers = requestHeaders(incoming.rawHeaders);
  const host: string | null = headers.get("host");
  if (host === null || host === "" || /[\s/@?#\\]/u.test(host))
    throw new Error("Invalid HTTP Host");
  const origin: URL = new URL(`http://${host}`);
  if (origin.username !== "" || origin.password !== "" || origin.pathname !== "/")
    throw new Error("Invalid HTTP Host");
  // Concatenation preserves a // path rather than treating it as a different authority.
  const url: URL = new URL(`${origin.origin}${target}`);
  const length: string | null = headers.get("content-length");
  const transfer: string | null = headers.get("transfer-encoding");
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new Error("Invalid HTTP content length");
  }
  if (transfer !== null && (transfer.toLowerCase() !== "chunked" || length !== null)) {
    throw new Error("Ambiguous HTTP body framing");
  }
  const declaredBytes: number | null = length === null ? null : Number(length);
  return {
    url,
    method,
    headers,
    declaredBytes,
    maximumBodyBytes: bodyMaximum(url.pathname, method, configuredMaximum),
    hasBody: transfer !== null || (declaredBytes !== null && declaredBytes > 0),
  };
}
