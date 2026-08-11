import { concatBytes } from "./encoding.js";

export const MIN_PADDED_INNER_BYTES: number = 512;
export const MAX_PADDED_INNER_BYTES: number = 512 * 1024;

export function paddedInnerLength(unpaddedLength: number): number {
  if (!Number.isSafeInteger(unpaddedLength) || unpaddedLength < 0) {
    throw new Error("Unpadded length must be a nonnegative safe integer");
  }
  let bucket: number = MIN_PADDED_INNER_BYTES;
  while (bucket < unpaddedLength && bucket < MAX_PADDED_INNER_BYTES) bucket *= 2;
  if (bucket < unpaddedLength || bucket > MAX_PADDED_INNER_BYTES) {
    throw new Error(`Encrypted message exceeds the ${MAX_PADDED_INNER_BYTES}-byte padded limit`);
  }
  return bucket;
}

export function padInnerPayload(
  unpadded: Uint8Array,
  paddedLength: number,
  randomPadding: Uint8Array,
): Uint8Array {
  if (paddedLength !== paddedInnerLength(unpadded.byteLength)) {
    throw new Error("Padded length is not the canonical bucket for this payload");
  }
  const expectedPadding: number = paddedLength - unpadded.byteLength;
  if (randomPadding.byteLength !== expectedPadding) {
    throw new Error("Random padding length does not fill the canonical bucket");
  }
  return concatBytes([unpadded, randomPadding]);
}
