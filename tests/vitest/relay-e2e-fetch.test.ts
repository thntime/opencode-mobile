import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchConnection } from '@/lib/opencode/client/fetch';
import { decryptBody, encryptBody, encryptStreamChunk } from '@/lib/relay/crypto';
import { isRelayE2EError } from '@/lib/relay/errors';
import { clearHostKeys, setHostKey } from '@/lib/relay/keywrap';
import type { OpencodeConnectionSettings } from '@/lib/opencode/client/types';

const counters = vi.hoisted(() => ({ recordBytes: vi.fn(), recordRequest: vi.fn() }));
const secure = vi.hoisted(() => ({ token: 'jwt-token' }));

vi.mock('@/lib/opencode/data-usage', () => counters);
vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async () => secure.token,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hostKey = new Uint8Array(32).fill(7);

function relaySettings(): OpencodeConnectionSettings {
  return {
    serverUrl: 'https://relay.example.test/relay/host-a',
    username: 'alice',
    password: 'host-secret',
    directory: '',
    relay: { relayUrl: 'https://relay.example.test', account: 'alice@example.test', hostId: 'host-a' },
  };
}

function directSettings(): OpencodeConnectionSettings {
  return { serverUrl: 'https://direct.example.test', username: 'alice', password: 'secret', directory: '' };
}

function sealed(value: string) {
  return encryptBody(encoder.encode(value), hostKey);
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
// Host key used to generate the Go interop vectors below.
const goHostKey = fromHex('8f1c2d3e4a5b6c7d8e9f00112233445566778899aabbccddeeff001122334455');

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function chunkedResponse(chunks: Uint8Array[], split = false) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (split) {
        for (const chunk of chunks) {
          for (let offset = 0; offset < chunk.length; offset += 5) controller.enqueue(chunk.slice(offset, offset + 5));
        }
      } else {
        controller.enqueue(concatBytes(chunks));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-e2e-stream': '1' } });
}

let transport: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearHostKeys();
  counters.recordRequest.mockClear();
  counters.recordBytes.mockClear();
  transport = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', transport);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay E2E requests', () => {
  beforeEach(() => setHostKey('host-a', hostKey));

  it('encrypts a non-empty body and keeps the caller content type', async () => {
    const body = JSON.stringify({ message: '你好', role: 'user' });
    await fetchConnection('https://relay.example.test/relay/host-a/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, relaySettings());

    const init = transport.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(typeof init.body).toBe('string');
    expect(decoder.decode(decryptBody(init.body as string, hostKey))).toBe(body);
    expect(headers.get('authorization')).toBe('Bearer jwt-token');
  });

  it('leaves GET requests without a body untouched', async () => {
    await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'GET' }, relaySettings());

    const init = transport.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });

  it('does not rewrite multipart uploads', async () => {
    await fetchConnection('https://relay.example.test/relay/host-a/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=abc' },
      body: 'raw-multipart',
    }, relaySettings());

    const init = transport.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('raw-multipart');
    expect(new Headers(init.headers).get('content-type')).toBe('multipart/form-data; boundary=abc');
  });

  it('encrypts ArrayBuffer bodies', async () => {
    const bytes = encoder.encode('binary payload');
    await fetchConnection('https://relay.example.test/relay/host-a/api/file', {
      method: 'PUT',
      body: bytes.buffer.slice(0) as ArrayBuffer,
    }, relaySettings());

    const init = transport.mock.calls[0][1] as RequestInit;
    expect(decoder.decode(decryptBody(init.body as string, hostKey))).toBe('binary payload');
  });
});

describe('relay E2E without a host key', () => {
  it('behaves exactly like a direct connection for requests', async () => {
    const body = JSON.stringify({ message: 'plain' });
    await fetchConnection('https://relay.example.test/relay/host-a/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, relaySettings());

    const init = transport.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('passes encrypted-looking responses through when no key was unlocked', async () => {
    const body = sealed('{"ok":true}');
    transport.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'POST' }, relaySettings());
    expect(await response.text()).toBe(body);
  });

  it('never decrypts a direct connection', async () => {
    const body = sealed('{"ok":true}');
    transport.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));

    const response = await fetchConnection('https://direct.example.test/api/session', { method: 'POST' }, directSettings());
    expect(await response.text()).toBe(body);
  });
});

describe('relay E2E whole-body responses', () => {
  beforeEach(() => setHostKey('host-a', hostKey));

  it('rebuilds a JSON response so response.json() still works', async () => {
    const payload = JSON.stringify({ session: { id: 'ses_1', title: '你好' } });
    transport.mockResolvedValue(new Response(sealed(payload), { status: 200, headers: { 'content-type': 'text/plain' } }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'POST' }, relaySettings());

    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ session: { id: 'ses_1', title: '你好' } });
  });

  it('keeps non-JSON plaintext as text/plain', async () => {
    transport.mockResolvedValue(new Response(sealed('plain 中文'), { status: 200, headers: { 'content-type': 'text/plain' } }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/file', { method: 'POST' }, relaySettings());

    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('plain 中文');
  });

  it('preserves the status code and rejects corrupt ciphertext', async () => {
    const corrupt = encryptBody(encoder.encode('{"error":"nope"}'), new Uint8Array(32).fill(9));
    transport.mockResolvedValue(new Response(corrupt, { status: 400, headers: { 'content-type': 'text/plain' } }));

    try {
      await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'POST' }, relaySettings());
      throw new Error('expected decryption to fail');
    } catch (error) {
      expect(isRelayE2EError(error, 'relay_e2e_decrypt_failed')).toBe(true);
    }
  });

  it('passes relay-level plaintext errors through unchanged', async () => {
    // 500 is not a relay-semantic status (403/502/503/504 are, see
    // relay-connection-mode.test.ts), so the plaintext gateway body survives.
    transport.mockResolvedValue(new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'POST' }, relaySettings());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });

  it('does not try to decrypt an empty body', async () => {
    transport.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/session', { method: 'DELETE' }, relaySettings());
    expect(response.status).toBe(204);
  });
});

describe('relay E2E streamed responses', () => {
  beforeEach(() => setHostKey('host-a', hostKey));

  it('decrypts merged stream chunks', async () => {
    const first = encryptStreamChunk(encoder.encode('data: one\n\n'), hostKey);
    const second = encryptStreamChunk(encoder.encode('data: two\n\n'), hostKey);
    transport.mockResolvedValue(chunkedResponse([first, second]));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());

    expect(response.headers.get('x-e2e-stream')).toBeNull();
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n');
  });

  it('decrypts chunks split across HTTP reads', async () => {
    const first = encryptStreamChunk(encoder.encode('data: alpha\n\n'), hostKey);
    const second = encryptStreamChunk(encoder.encode('data: beta\n\n'), hostKey);
    transport.mockResolvedValue(chunkedResponse([first, second], true));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());

    expect(await response.text()).toBe('data: alpha\n\ndata: beta\n\n');
  });

  it('decrypts a chunk produced by the Go tunnel client', async () => {
    // `encryptSSEChunk` output for the same host key and
    // `data: {"type":"server.connected"}\n\n`.
    setHostKey('host-a', goHostKey);
    const chunk = fromHex('0000002376de03fdb51a8b4462f69df98ca915ee4ed8e2236db7a8177b1395c645e95d5094cfd4dd66db61ccb36af2486acef86569ffa1dad501b6807409f245c275a9');
    transport.mockResolvedValue(chunkedResponse([chunk]));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());

    expect(await response.text()).toBe('data: {"type":"server.connected"}\n\n');
  });

  it('fails the stream on an absurd length prefix instead of dropping data', async () => {
    const invalid = new Uint8Array(4 + 12 + 16);
    new DataView(invalid.buffer).setUint32(0, 0x7fffffff, false);
    transport.mockResolvedValue(chunkedResponse([invalid]));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());
    await expect(response.text()).rejects.toThrow(/invalid chunk length/i);
  });

  it('fails the stream when it ends mid-frame', async () => {
    const frame = encryptStreamChunk(encoder.encode('data: truncated\n\n'), hostKey);
    transport.mockResolvedValue(chunkedResponse([frame.slice(0, frame.length - 3)]));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());
    await expect(response.text()).rejects.toThrow(/ended in the middle/i);
  });

  it('leaves X-E2E-Stream=0 responses alone', async () => {
    transport.mockResolvedValue(new Response('data: plain\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-e2e-stream': '0' },
    }));

    const response = await fetchConnection('https://relay.example.test/relay/host-a/api/event', { method: 'POST' }, relaySettings());
    expect(await response.text()).toBe('data: plain\n\n');
  });
});
