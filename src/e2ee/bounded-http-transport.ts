import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

const FETCH_TIMEOUT_MS: number = 30_000;
const MAX_RESPONSE_BYTES: number = 64 * 1024 * 1024;
const SESSION_ID_PATTERN: RegExp = /^[\x21-\x7e]{1,128}$/u;

function responseMediaType(response: Response): string {
  const contentType: string | null = response.headers.get("content-type");
  if (contentType === null) return "";
  const separator: number = contentType.indexOf(";");
  return (separator === -1 ? contentType : contentType.slice(0, separator)).trim().toLowerCase();
}

async function boundedResponseText(response: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const result: { readonly done: boolean; readonly value?: Uint8Array | undefined } =
        await reader.read();
      if (result.done) break;
      const value: Uint8Array | undefined = result.value;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The encrypted Murmur HTTP response exceeds its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  chunks.forEach((chunk: Uint8Array): void => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJsonRpc(value: unknown): JSONRPCMessage {
  const parsed: ReturnType<typeof JSONRPCMessageSchema.safeParse> =
    JSONRPCMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("The encrypted Murmur HTTP response is invalid");
  return parsed.data;
}

function parseJsonResponses(text: string): readonly JSONRPCMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (_error: unknown) {
    throw new Error("The encrypted Murmur HTTP response is invalid");
  }
  if (!Array.isArray(value)) return [parseJsonRpc(value)];
  return value.map((item: unknown): JSONRPCMessage => parseJsonRpc(item));
}

function parseSseResponses(text: string): readonly JSONRPCMessage[] {
  const normalized: string = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const events: readonly string[] = normalized.split("\n\n");
  const messages: JSONRPCMessage[] = [];
  events.forEach((event: string): void => {
    const data: string[] = [];
    event.split("\n").forEach((line: string): void => {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    });
    if (data.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(data.join("\n"));
    } catch (_error: unknown) {
      throw new Error("The encrypted Murmur HTTP event stream is invalid");
    }
    messages.push(parseJsonRpc(value));
  });
  if (messages.length === 0) {
    throw new Error("The encrypted Murmur HTTP event stream contained no response");
  }
  return messages;
}

export class BoundedHttpClientTransport implements Transport {
  public onclose: () => void = (): void => undefined;
  public onerror: (error: Error) => void = (_error: Error): void => undefined;
  public onmessage: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void = <
    T extends JSONRPCMessage,
  >(
    _message: T,
    _extra?: MessageExtraInfo,
  ): void => undefined;

  readonly #endpoint: URL;
  readonly #headers: Headers;
  #abortController: AbortController | null = null;
  #closed: boolean = false;
  #protocolVersion: string | null = null;
  #sessionId: string | null = null;

  public constructor(endpoint: URL, headers: Headers) {
    this.#endpoint = new URL(endpoint.toString());
    this.#headers = new Headers(headers);
  }

  public async start(): Promise<void> {
    if (this.#abortController !== null) {
      throw new Error("The encrypted Murmur HTTP transport is already started");
    }
    if (this.#closed) throw new Error("The encrypted Murmur HTTP transport is closed");
    this.#abortController = new AbortController();
  }

  private requestHeaders(): Headers {
    const headers: Headers = new Headers(this.#headers);
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");
    if (this.#sessionId !== null) headers.set("mcp-session-id", this.#sessionId);
    if (this.#protocolVersion !== null) {
      headers.set("mcp-protocol-version", this.#protocolVersion);
    }
    return headers;
  }

  private deliver(messages: readonly JSONRPCMessage[]): void {
    messages.forEach((message: JSONRPCMessage): void => {
      this.onmessage(message);
    });
  }

  public async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const controller: AbortController | null = this.#abortController;
    if (controller === null || this.#closed) {
      throw new Error("The encrypted Murmur HTTP transport is not open");
    }
    const deadline: AbortSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal: AbortSignal = AbortSignal.any([controller.signal, deadline]);
    try {
      const response: Response = await fetch(this.#endpoint, {
        body: JSON.stringify(message),
        headers: this.requestHeaders(),
        method: "POST",
        redirect: "error",
        signal,
      });
      const sessionId: string | null = response.headers.get("mcp-session-id");
      if (sessionId !== null) {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          if (response.body !== null) await response.body.cancel();
          throw new Error("The encrypted Murmur HTTP session identifier is invalid");
        }
        this.#sessionId = sessionId;
      }
      if (!response.ok) {
        if (response.body !== null) await response.body.cancel();
        throw new Error("The encrypted Murmur HTTP service rejected the request");
      }
      if (response.status === 202) {
        if (response.body !== null) await response.body.cancel();
        return;
      }
      const mediaType: string = responseMediaType(response);
      const text: string = await boundedResponseText(response);
      if (mediaType === "application/json") {
        this.deliver(parseJsonResponses(text));
        return;
      }
      if (mediaType === "text/event-stream") {
        this.deliver(parseSseResponses(text));
        return;
      }
      throw new Error("The encrypted Murmur HTTP service returned an unsupported response");
    } catch (error: unknown) {
      const safeError: Error =
        error instanceof Error
          ? error
          : new Error("The encrypted Murmur HTTP service request failed");
      this.onerror(safeError);
      throw safeError;
    }
  }

  public setProtocolVersion(version: string): void {
    if (version.length < 1 || version.length > 50) {
      throw new Error("The encrypted Murmur protocol version is invalid");
    }
    this.#protocolVersion = version;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const controller: AbortController | null = this.#abortController;
    if (controller !== null) controller.abort();
    this.onclose();
  }
}
