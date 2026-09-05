import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

function eventMessage(event: string): JSONRPCMessage | null {
  const data: string[] = event
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data:"))
    .map((line: string): string => line.slice(5).trimStart());
  if (data.length === 0) return null;
  try {
    return JSONRPCMessageSchema.parse(JSON.parse(data.join("\n")));
  } catch (_error: unknown) {
    throw new Error("The Murmur HTTP event stream is invalid");
  }
}

export async function deliverHttpEventStream(
  response: Response,
  maximumBytes: number,
  deliver: (message: JSONRPCMessage) => void,
): Promise<void> {
  if (response.body === null) throw new Error("The Murmur HTTP event stream is empty");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true });
  let bytes: number = 0;
  let buffered: string = "";
  let pendingCarriageReturn: boolean = false;
  let delivered: boolean = false;
  const append: (text: string, done: boolean) => void = (text: string, done: boolean): void => {
    let normalized: string = `${pendingCarriageReturn ? "\r" : ""}${text}`;
    pendingCarriageReturn = !done && normalized.endsWith("\r");
    if (pendingCarriageReturn) normalized = normalized.slice(0, -1);
    buffered += normalized.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (done && buffered !== "") buffered += "\n\n";
    let boundary: number = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const message: JSONRPCMessage | null = eventMessage(buffered.slice(0, boundary));
      buffered = buffered.slice(boundary + 2);
      if (message !== null) {
        delivered = true;
        deliver(message);
      }
      boundary = buffered.indexOf("\n\n");
    }
  };
  try {
    while (true) {
      const result: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (result.done) {
        append(decoder.decode(), true);
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) throw new Error("The Murmur HTTP response exceeds its size limit");
      append(decoder.decode(result.value, { stream: true }), false);
    }
    if (!delivered) throw new Error("The Murmur HTTP event stream contained no response");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
