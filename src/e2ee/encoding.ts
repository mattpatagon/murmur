const NULL_LENGTH: number = 0xffff_ffff;
const MAX_CANONICAL_FIELD_BYTES: number = 64 * 1024;
const MAX_SAFE_BIGINT: bigint = BigInt(Number.MAX_SAFE_INTEGER);

const encoder: TextEncoder = new TextEncoder();
const decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true });

function checkedU32(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= NULL_LENGTH) {
    throw new Error(`${field} must be an unsigned 32-bit integer below the null marker`);
  }
  return value;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total: number = chunks.reduce(
    (sum: number, chunk: Uint8Array): number => sum + chunk.byteLength,
    0,
  );
  const result: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  chunks.forEach((chunk: Uint8Array): void => {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return result;
}

export class BinaryWriter {
  readonly #chunks: Uint8Array[] = [];

  public writeBytes(value: Uint8Array): void {
    this.writeU32(value.byteLength);
    this.#chunks.push(value);
  }

  public writeNullableString(value: string | null): void {
    if (value === null) {
      const marker: Uint8Array = new Uint8Array(4);
      new DataView(marker.buffer).setUint32(0, NULL_LENGTH, false);
      this.#chunks.push(marker);
      return;
    }
    this.writeString(value);
  }

  public writeString(value: string): void {
    const bytes: Uint8Array = encoder.encode(value);
    if (bytes.byteLength > MAX_CANONICAL_FIELD_BYTES) {
      throw new Error(`Canonical field exceeds ${MAX_CANONICAL_FIELD_BYTES} bytes`);
    }
    this.writeBytes(bytes);
  }

  public writeU32(value: number): void {
    const bytes: Uint8Array = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, checkedU32(value, "value"), false);
    this.#chunks.push(bytes);
  }

  public writeU64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("value must be a nonnegative safe integer");
    }
    const bytes: Uint8Array = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
    this.#chunks.push(bytes);
  }

  public finish(): Uint8Array {
    return concatBytes(this.#chunks);
  }
}

export class BinaryReader {
  readonly #bytes: Uint8Array;
  #offset: number = 0;

  public constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  public get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  public readBytes(): Uint8Array {
    const length: number = this.readU32();
    if (length === NULL_LENGTH) throw new Error("Expected bytes but received a null marker");
    return this.#take(length);
  }

  public readNullableString(): string | null {
    const length: number = this.readU32();
    if (length === NULL_LENGTH) return null;
    return decoder.decode(this.#take(length));
  }

  public readString(): string {
    const value: string | null = this.readNullableString();
    if (value === null) throw new Error("Expected a string but received a null marker");
    return value;
  }

  public readU32(): number {
    const bytes: Uint8Array = this.#take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  }

  public readU64(): number {
    const bytes: Uint8Array = this.#take(8);
    const value: bigint = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigUint64(0, false);
    if (value > MAX_SAFE_BIGINT) throw new Error("Canonical integer exceeds safe range");
    return Number(value);
  }

  public skipRemaining(): void {
    this.#offset = this.#bytes.byteLength;
  }

  #take(length: number): Uint8Array {
    checkedU32(length, "length");
    if (length > this.remaining) throw new Error("Canonical value is truncated");
    const start: number = this.#offset;
    this.#offset += length;
    return this.#bytes.slice(start, this.#offset);
  }
}
