import { gcm } from '@noble/ciphers/aes';

import { decodeBase64Bytes, encodeBase64Bytes } from './base64';
import { RelayE2EError } from './errors';
import { randomBytes } from './random';

// D5 wire format. Every payload is AES-256-GCM sealed as
// `nonce(12) || ciphertext || tag(16)`; only the outer encoding differs.
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const HOST_KEY_BYTES = 32;
// A single streamed frame carries at most 1 MiB of plaintext. The tunnel chunks
// at 32 KiB, so anything above this is a corrupt length prefix, not real data.
export const MAX_STREAM_CHUNK_BYTES = 1024 * 1024;

function assertKey(key: Uint8Array) {
  if (key.length !== HOST_KEY_BYTES) {
    throw new RelayE2EError('relay_e2e_unavailable', 'A Relay host key must be 32 bytes.');
  }
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

// Raw `nonce || ciphertext || tag`, used by WebSocket frames.
export function encryptFrame(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return out;
}

export function decryptFrame(data: Uint8Array, key: Uint8Array): Uint8Array {
  assertKey(key);
  if (data.length < NONCE_BYTES + TAG_BYTES) {
    throw new RelayE2EError('relay_e2e_decrypt_failed', 'The encrypted Relay payload is too short.');
  }
  try {
    return gcm(key, data.subarray(0, NONCE_BYTES)).decrypt(data.subarray(NONCE_BYTES));
  } catch {
    throw new RelayE2EError('relay_e2e_decrypt_failed', 'The Relay payload could not be decrypted.');
  }
}

// Whole-body requests/responses: base64(nonce || ciphertext || tag).
export function encryptBody(bytes: Uint8Array, key: Uint8Array): string {
  return encodeBase64Bytes(encryptFrame(bytes, key));
}

export function decryptBody(value: string, key: Uint8Array): Uint8Array {
  let data: Uint8Array;
  try {
    data = decodeBase64Bytes(value.trim());
  } catch {
    throw new RelayE2EError('relay_e2e_decrypt_failed', 'The Relay payload is not valid base64.');
  }
  return decryptFrame(data, key);
}

// Streamed responses: `uint32 BE plaintext length || nonce || ciphertext || tag`.
// The length prefix is explicit because HTTP chunk boundaries are not a framing
// signal (the tunnel may split or coalesce frames).
export function encryptStreamChunk(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const frame = encryptFrame(plaintext, key);
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, plaintext.length, false);
  out.set(frame, 4);
  return out;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

// Transformer for `TransformStream`. It buffers partial frames across chunks and
// fails the stream (instead of dropping bytes) when a length prefix is absurd or
// the stream ends mid-frame.
export function createStreamDecryptTransformer(key: Uint8Array): Transformer<Uint8Array, Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0);

  return {
    transform(chunk, controller) {
      pending = concat(pending, toBytes(chunk));

      while (pending.length >= 4) {
        const length = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0, false);
        if (length > MAX_STREAM_CHUNK_BYTES) {
          controller.error(new RelayE2EError(
            'relay_e2e_stream_invalid',
            `The Relay stream announced an invalid chunk length (${length} bytes).`,
          ));
          pending = new Uint8Array(0);
          return;
        }

        const total = 4 + NONCE_BYTES + length + TAG_BYTES;
        if (pending.length < total) return;

        let plaintext: Uint8Array;
        try {
          plaintext = decryptFrame(pending.subarray(4, total), key);
        } catch (error) {
          controller.error(error);
          pending = new Uint8Array(0);
          return;
        }
        if (plaintext.length !== length) {
          controller.error(new RelayE2EError(
            'relay_e2e_stream_invalid',
            'The Relay stream chunk length does not match its payload.',
          ));
          pending = new Uint8Array(0);
          return;
        }

        controller.enqueue(plaintext);
        pending = pending.slice(total);
      }
    },

    flush(controller) {
      if (pending.length > 0) {
        controller.error(new RelayE2EError(
          'relay_e2e_stream_truncated',
          'The Relay stream ended in the middle of an encrypted chunk.',
        ));
      }
    },
  };
}

export function createStreamDecryptStream(key: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>(createStreamDecryptTransformer(key));
}
