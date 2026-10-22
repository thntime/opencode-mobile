import { createStreamDecryptStream, decryptBody, encryptBody } from './crypto';
import { RelayE2EError } from './errors';
import { getHostKeyForServerUrl } from './host-key-cache';

// D5: the tunnel decrypts every non-empty request body unconditionally, so a
// Relay request with a cached host key must never leave in plaintext. Multipart
// bodies cannot be rewritten safely and SSE requests carry no body.
const SKIPPED_CONTENT_TYPES = ['multipart/form-data', 'text/event-stream'];
const SEALED_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type RelaySettings = { relay?: unknown; serverUrl?: string };

// A host key only exists after a successful `unlockHostKey`, so an absent key
// means "the user skipped the passphrase" (or the host has no E2E key): the
// whole layer must behave exactly like a direct connection.
export function relayHostKeyFor(settings?: RelaySettings): Uint8Array | undefined {
  if (!settings?.relay || !settings.serverUrl) return undefined;
  return getHostKeyForServerUrl(settings.serverUrl);
}

async function bodyBytes(body: BodyInit): Promise<Uint8Array | undefined> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  // FormData and ReadableStream bodies are intentionally left untouched.
  return undefined;
}

export async function encryptRelayRequest(init: RequestInit | undefined, key: Uint8Array): Promise<RequestInit | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) return init;

  const headers = new Headers(init?.headers);
  const contentType = (headers.get('content-type') ?? '').toLowerCase();
  if (SKIPPED_CONTENT_TYPES.some((type) => contentType.includes(type))) return init;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return init;

  const bytes = await bodyBytes(body);
  if (!bytes || bytes.length === 0) return init;

  // The tunnel rewrites `Content-Type` on encrypted responses; requests use
  // `text/plain` so no proxy tries to parse the base64 payload.
  headers.set('Content-Type', 'text/plain');
  headers.delete('Content-Length');
  return { ...init, body: encryptBody(bytes, key), headers };
}

function looksLikeSealedBody(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 40 && trimmed.length % 4 === 0 && SEALED_BODY_PATTERN.test(trimmed);
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function rebuildResponse(response: Response, body: string, contentType: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', contentType);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function decryptStreamResponse(response: Response, key: Uint8Array): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('x-e2e-stream');
  const body = response.body!.pipeThrough(createStreamDecryptStream(key));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// D9: whole-body responses arrive as `text/plain` + base64 because the tunnel
// overrides the original type. The plaintext type is reconstructed here so
// `response.json()` keeps working for the SDK.
export async function decryptRelayResponse(response: Response, key: Uint8Array): Promise<Response> {
  const streamMarker = response.headers.get('x-e2e-stream');
  if (streamMarker === '0') return response;
  if (streamMarker === '1' && response.body) return decryptStreamResponse(response, key);

  const contentType = response.headers.get('content-type') ?? '';
  if (!/^text\/plain\b/i.test(contentType)) return response;
  if (!response.body || response.status === 204 || response.status === 304) return response;

  const raw = await response.text();
  if (!looksLikeSealedBody(raw)) {
    // A relay-level error page (nginx, gateway) is plaintext, not ciphertext.
    // The body was consumed above, so it still needs rebuilding.
    return rebuildResponse(response, raw, contentType);
  }

  let plaintext: string;
  try {
    plaintext = new TextDecoder().decode(decryptBody(raw, key));
  } catch (error) {
    throw error instanceof RelayE2EError
      ? error
      : new RelayE2EError('relay_e2e_decrypt_failed', 'The Relay response could not be decrypted.');
  }

  return rebuildResponse(response, plaintext, isJson(plaintext) ? 'application/json' : 'text/plain; charset=utf-8');
}
