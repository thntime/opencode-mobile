import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELAY_TOKEN_STORAGE_KEY,
  RelayLoginError,
  clearRelayToken,
  decodeTokenExpiry,
  getRelayToken,
  isRelayTokenExpiring,
  login,
  logout,
  saveRelayToken,
} from '@/lib/relay/auth';

// lib/relay/auth.ts owns the Relay login handshake and the single SecureStore
// token slot. Native boundaries are stubbed so the assertions describe behavior
// (what is written, what is rejected) instead of source text.
const h = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  secureOptions: [] as (Record<string, unknown> | undefined)[],
  storage: new Map<string, string>(),
}));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async (key: string) => h.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options?: Record<string, unknown>) => {
    h.secure.set(key, value);
    h.secureOptions.push(options);
  },
  deleteItemAsync: async (key: string) => { h.secure.delete(key); },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => h.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.storage.set(key, value); },
    removeItem: async (key: string) => { h.storage.delete(key); },
  },
}));

const SETTINGS_KEY = 'opencode-mobile.settings';

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(payload: Record<string, unknown>) {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.signature`;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function loginFetch(payload: unknown, status = 200) {
  return vi.fn(async () => jsonResponse(payload, status));
}

beforeEach(async () => {
  h.secure.clear();
  h.secureOptions.length = 0;
  h.storage.clear();
  await clearRelayToken();
  vi.unstubAllGlobals();
});

describe('relay login', () => {
  it('posts the account credentials and returns the token plus its JWT expiry', async () => {
    const token = jwt({ user_id: 7, exp: 1_900_000_000 });
    const transport = loginFetch({ token, user: { id: 7, email: 'alice@example.test' } });
    vi.stubGlobal('fetch', transport);

    const result = await login('https://relay.example.test/', ' alice@example.test ', 'secret');

    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example.test/api/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'alice@example.test', password: 'secret' });
    expect(result.token).toBe(token);
    expect(result.user).toEqual({ id: 7, email: 'alice@example.test' });
    expect(result.tokenExpiresAt).toBe(1_900_000_000_000);

    // A successful sign-in is written to the single SecureStore slot so a
    // relaunch stays logged in without keeping the password.
    expect(h.secure.get(RELAY_TOKEN_STORAGE_KEY)).toBe(token);
    expect(h.secureOptions.at(-1)).toEqual({ keychainAccessible: 'when-unlocked-this-device-only' });
    expect(await getRelayToken()).toBe(token);
  });

  it('rejects bad credentials without writing any login state', async () => {
    vi.stubGlobal('fetch', loginFetch({ error: 'invalid email or password' }, 401));

    await expect(login('https://relay.example.test', 'alice@example.test', 'wrong')).rejects.toMatchObject({
      name: 'RelayLoginError',
      code: 'invalid_credentials',
      status: 401,
    });
    expect(h.secure.size).toBe(0);
    expect(await getRelayToken()).toBeUndefined();
  });

  it('reports an unreachable relay without writing any login state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));

    const error = await login('relay.example.test', 'alice@example.test', 'secret').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RelayLoginError);
    expect((error as RelayLoginError).code).toBe('unreachable');
    expect(h.secure.size).toBe(0);
  });

  it('treats a missing token in the response as a protocol error', async () => {
    vi.stubGlobal('fetch', loginFetch({ user: { email: 'alice@example.test' } }));
    await expect(login('https://relay.example.test', 'alice@example.test', 'secret')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(h.secure.size).toBe(0);
  });

  it('treats a 5xx as unreachable rather than a rejected credential', async () => {
    vi.stubGlobal('fetch', loginFetch({ error: 'login failed' }, 500));
    await expect(login('https://relay.example.test', 'alice@example.test', 'secret')).rejects.toMatchObject({ code: 'unreachable', status: 500 });
    expect(h.secure.size).toBe(0);
  });

  it('treats throttling as unreachable too', async () => {
    vi.stubGlobal('fetch', loginFetch({ error: 'slow down' }, 429));
    await expect(login('https://relay.example.test', 'alice@example.test', 'secret')).rejects.toMatchObject({ code: 'unreachable', status: 429 });
    expect(h.secure.size).toBe(0);
  });
});

describe('relay token lifecycle', () => {
  it('reads, caches, and clears the SecureStore token', async () => {
    h.secure.set(RELAY_TOKEN_STORAGE_KEY, 'stored-token');
    expect(await getRelayToken()).toBe('stored-token');

    await saveRelayToken('fresh-token');
    expect(h.secure.get(RELAY_TOKEN_STORAGE_KEY)).toBe('fresh-token');
    expect(await getRelayToken()).toBe('fresh-token');

    await clearRelayToken();
    expect(h.secure.has(RELAY_TOKEN_STORAGE_KEY)).toBe(false);
    expect(await getRelayToken()).toBeUndefined();
  });

  it('clears the token and the persisted relay login on logout', async () => {
    h.secure.set(RELAY_TOKEN_STORAGE_KEY, 'stored-token');
    h.storage.set(SETTINGS_KEY, JSON.stringify({
      serverUrl: 'https://relay.example.test/relay/host-a',
      username: 'alice',
      directory: '/repo',
      relay: { relayUrl: 'https://relay.example.test', account: 'alice@example.test', hostId: 'host-a' },
    }));

    await logout();

    expect(h.secure.has(RELAY_TOKEN_STORAGE_KEY)).toBe(false);
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string)).toEqual({
      serverUrl: 'https://relay.example.test/relay/host-a',
      username: 'alice',
      directory: '/repo',
    });
  });

  it('keeps unreadable settings untouched on logout', async () => {
    h.storage.set(SETTINGS_KEY, '{not json');
    await expect(logout()).resolves.toBeUndefined();
    expect(h.storage.get(SETTINGS_KEY)).toBe('{not json');
  });
});

describe('relay token expiry', () => {
  it('parses the exp claim as milliseconds and tolerates opaque tokens', () => {
    expect(decodeTokenExpiry(jwt({ exp: 1_900_000_000 }))).toBe(1_900_000_000_000);
    expect(decodeTokenExpiry(jwt({ sub: 'no-exp' }))).toBeUndefined();
    expect(decodeTokenExpiry('opaque-token')).toBeUndefined();
    expect(decodeTokenExpiry('a.!!!.c')).toBeUndefined();
    expect(decodeTokenExpiry('')).toBeUndefined();
  });

  it('treats a token as expiring inside the five minute refresh window', () => {
    const now = 1_900_000_000_000;
    expect(isRelayTokenExpiring(now - 1, now)).toBe(true);
    expect(isRelayTokenExpiring(now + 60_000, now)).toBe(true);
    expect(isRelayTokenExpiring(now + 6 * 60_000, now)).toBe(false);
    expect(isRelayTokenExpiring(undefined, now)).toBe(false);
  });
});
