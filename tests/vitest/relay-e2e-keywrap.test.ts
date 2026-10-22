import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRelayToken } from '@/lib/relay/auth';
import { decodeBase64Bytes } from '@/lib/relay/base64';
import { isRelayE2EError } from '@/lib/relay/errors';
import {
  clearHostKeys,
  deriveKek,
  fetchHostKey,
  getHostKey,
  getHostKeyForServerUrl,
  relayHostIdFromServerUrl,
  setHostKey,
  unlockHostKey,
  unwrapHostKey,
} from '@/lib/relay/keywrap';
import { isRelayReauthRequired, resetRelayRefreshState } from '@/lib/relay/refresh';
import { clearPassphrase, getPassphrase, setPassphrase } from '@/lib/relay/session-key';
import { clearRelaySessionPassword, setRelaySessionPassword } from '@/lib/relay/session-password';

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

// Fixed vector produced by the tunnel client's Go `wrapHostKey` + `encrypt`
// (scrypt N=2^15 r=8 p=1 dkLen=32, then AES-256-GCM over the 32-byte host key).
// Interop with the Go implementation is the whole point of pinning it here.
const GO_VECTOR = {
  passphrase: 'correct horse battery staple',
  saltBase64: 'AAECAwQFBgcICQoLDA0ODw==',
  kekHex: '7a8e34241db898d59175c696538c417467a975ffe569068425f16188d3159c58',
  hostKeyHex: '8f1c2d3e4a5b6c7d8e9f00112233445566778899aabbccddeeff001122334455',
  wrappedBase64: 'W3aPAKVMbU7Jsh7yPCHzvqiED8r5xdnYSd8E0PoW+bGsCq+GGCBuDb5N5teW0aJ4R3XM8puB1VZ6LPt/',
};

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const material = {
  key_wrapped: GO_VECTOR.wrappedBase64,
  key_salt: GO_VECTOR.saltBase64,
  key_kdf: 'scrypt-n15-r8-p1',
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  clearHostKeys();
  clearPassphrase();
  resetRelayRefreshState();
  clearRelaySessionPassword();
  await clearRelayToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelayRefreshState();
  clearRelaySessionPassword();
});

describe('relay host key unwrapping', () => {
  it('unwraps a key wrapped by the Go tunnel client', () => {
    const salt = decodeBase64Bytes(GO_VECTOR.saltBase64);
    const kek = deriveKek(GO_VECTOR.passphrase, salt);

    expect(toHex(kek)).toBe(GO_VECTOR.kekHex);
    expect(toHex(unwrapHostKey(GO_VECTOR.wrappedBase64, kek))).toBe(GO_VECTOR.hostKeyHex);
  });

  it('reports a wrong passphrase with a stable code', () => {
    const salt = decodeBase64Bytes(GO_VECTOR.saltBase64);
    const kek = deriveKek('not the passphrase', salt);

    try {
      unwrapHostKey(GO_VECTOR.wrappedBase64, kek);
      throw new Error('expected unwrapHostKey to reject');
    } catch (error) {
      expect(isRelayE2EError(error, 'relay_e2e_bad_passphrase')).toBe(true);
    }
  });

  it('treats malformed wrapped material as a bad passphrase', () => {
    expect(() => unwrapHostKey('AAAA', new Uint8Array(32))).toThrowError(/could not be unwrapped|incorrect/i);
    expect(() => unwrapHostKey('not base64!', new Uint8Array(32))).toThrow();
  });
});

describe('relay host key fetch', () => {
  it('requests the host key with the relay bearer token', async () => {
    const transport = vi.fn(async () => respond(material));
    vi.stubGlobal('fetch', transport);

    const result = await fetchHostKey('https://relay.example.test/', 'host-a', 'jwt-token');

    expect(result).toEqual({ wrapped: GO_VECTOR.wrappedBase64, salt: GO_VECTOR.saltBase64, kdf: 'scrypt-n15-r8-p1' });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example.test/api/hosts/host-a/key');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt-token');
  });

  it('maps a 403 to unauthorized without trying to refresh', async () => {
    const transport = vi.fn(async () => respond({ error: 'nope' }, 403));
    vi.stubGlobal('fetch', transport);
    await expect(fetchHostKey('https://relay.example.test', 'host-a', 'jwt')).rejects.toMatchObject({ code: 'relay_e2e_unauthorized' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refreshes once before mapping a 401 to unauthorized', async () => {
    setRelaySessionPassword('secret');
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? respond({ token: 'fresh-jwt' }) : respond({ error: 'nope' }, 401)
    ));
    vi.stubGlobal('fetch', transport);

    // A refreshed token that is still rejected is an authorization failure for
    // this request, not an unrecoverable session.
    await expect(fetchHostKey('https://relay.example.test', 'host-a', 'jwt', 'alice@example.test'))
      .rejects.toMatchObject({ code: 'relay_e2e_unauthorized' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('propagates relay_reauth_required when no password can refresh the session', async () => {
    const transport = vi.fn(async () => respond({ error: 'nope' }, 401));
    vi.stubGlobal('fetch', transport);

    const error = await fetchHostKey('https://relay.example.test', 'host-a', 'jwt', 'alice@example.test').catch((reason: unknown) => reason);

    expect(isRelayReauthRequired(error)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('maps other failures to key_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: 'boom' }, 500)));
    await expect(fetchHostKey('https://relay.example.test', 'host-a', 'jwt')).rejects.toMatchObject({ code: 'relay_e2e_key_unavailable' });
  });

  it('rejects an unsupported KDF instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ ...material, key_kdf: 'argon2id' })));
    await expect(fetchHostKey('https://relay.example.test', 'host-a', 'jwt')).rejects.toMatchObject({ code: 'relay_e2e_key_unavailable' });
  });
});

describe('relay host key unlock', () => {
  it('caches the unlocked key for the host carried in serverUrl', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(material)));

    const key = await unlockHostKey({ relayUrl: 'https://relay.example.test', hostId: 'host-a', passphrase: GO_VECTOR.passphrase, token: 'jwt' });

    expect(toHex(key!)).toBe(GO_VECTOR.hostKeyHex);
    expect(toHex(getHostKey('host-a')!)).toBe(GO_VECTOR.hostKeyHex);
    expect(relayHostIdFromServerUrl('https://relay.example.test/relay/host-a')).toBe('host-a');
    expect(relayHostIdFromServerUrl('https://relay.example.test/relay/host-a/api/session')).toBe('host-a');
    expect(toHex(getHostKeyForServerUrl('https://relay.example.test/relay/host-a/api/session')!)).toBe(GO_VECTOR.hostKeyHex);
    expect(getHostKeyForServerUrl('https://direct.example.test')).toBeUndefined();
    expect(getPassphrase()).toBe(GO_VECTOR.passphrase);
  });

  it('skips encryption when the host has no E2E key (passphrase skipped)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ key_wrapped: '', key_salt: '', key_kdf: '' })));

    const key = await unlockHostKey({ relayUrl: 'https://relay.example.test', hostId: 'host-a', passphrase: 'anything', token: 'jwt' });

    expect(key).toBeUndefined();
    expect(getHostKey('host-a')).toBeUndefined();
    expect(getHostKeyForServerUrl('https://relay.example.test/relay/host-a')).toBeUndefined();
  });

  it('never leaves a previous key cached after a failed unlock', async () => {
    setHostKey('host-a', fromHex(GO_VECTOR.hostKeyHex));
    vi.stubGlobal('fetch', vi.fn(async () => respond(material)));

    await expect(unlockHostKey({ relayUrl: 'https://relay.example.test', hostId: 'host-a', passphrase: 'wrong', token: 'jwt' }))
      .rejects.toMatchObject({ code: 'relay_e2e_bad_passphrase' });
    expect(getHostKey('host-a')).toBeUndefined();
  });
});

describe('relay passphrase cache', () => {
  it('keeps the passphrase in memory only and clears it on demand', () => {
    expect(getPassphrase()).toBeUndefined();
    setPassphrase('hunter2');
    expect(getPassphrase()).toBe('hunter2');
    setPassphrase('');
    expect(getPassphrase()).toBeUndefined();
    setPassphrase('again');
    clearPassphrase();
    expect(getPassphrase()).toBeUndefined();
  });
});
