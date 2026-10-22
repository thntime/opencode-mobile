import { decode, encode } from 'base-64';

// `base-64` works on binary strings. Chunking keeps `String.fromCharCode` away
// from the argument-count limit on large encrypted bodies.
const CHUNK_SIZE = 0x8000;

export function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return encode(binary);
}

export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = decode(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
