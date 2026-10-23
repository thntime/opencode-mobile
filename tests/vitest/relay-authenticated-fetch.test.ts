import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRelayToken, getRelayToken } from '@/lib/relay/auth';
import { relayFetch } from '@/lib/relay/authenticated-fetch';
import { fetchRelayHosts } from '@/lib/relay/hosts';
import { clearHostKeys, fetchHostKey } from '@/lib/relay/keywrap';
import {
  RelayLoginRequiredError,
  RelayReauthRequiredError,
  RelayUnreachableError,
  isRelayReauthRequired,
  resetRelayRefreshState,
} from '@/lib/relay/refresh';
import { clearRelaySessionPassword, setRelaySessionPassword } from '@/lib/relay/session-password';

const h = vi.hoisted(() => ({ secure: new Map<string, string>(), storage: new Map<string, string>(), tokenDeletes: 0 }));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async (key: string) => h.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { h.secure.set(key, value); },
  deleteItemAsync: async (key: string) => {
    if (key === 'opencode-mobile.relay-token') h.tokenDeletes += 1;
    h.secure.delete(key);
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => h.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.storage.set(key, value); },
    removeItem: async (key: string) => { h.storage.delete(key); },
  },
}));

const TOKEN_KEY = 'opencode-mobile.relay-token';
const SETTINGS_KEY = 'opencode-mobile.settings';
const RELAY_URL = 'https://relay.example.test';
const ACCOUNT = 'alice@example.test';

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(expSeconds: number) {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ exp: expSeconds })}.signature`;
}

const expiredToken = () => jwt(Math.floor(Date.now() / 1000) - 60);
const futureToken = () => jwt(Math.floor(Date.now() / 1000) + 3_600);

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function loginResponse(token: string) {
  return json({ token, user: { email: ACCOUNT } });
}

function persistRelay() {
  h.storage.set(SETTINGS_KEY, JSON.stringify({ relay: { relayUrl: RELAY_URL, account: ACCOUNT } }));
}

function urlsOf(transport: ReturnType<typeof vi.fn>) {
  return (transport.mock.calls as unknown as [string, RequestInit][]).map(([url]) => url);
}

function authOf(init: RequestInit | undefined) {
  return new Headers(init?.headers).get('authorization');
}

beforeEach(async () => {
  h.secure.clear();
  h.storage.clear();
  clearHostKeys();
  resetRelayRefreshState();
  clearRelaySessionPassword();
  await clearRelayToken();
  h.tokenDeletes = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelayRefreshState();
  clearRelaySessionPassword();
});

describe('relay control-plane token refresh', () => {
  it('refreshes an expiring token before listing hosts', async () => {
    setRelaySessionPassword('secret');
    persistRelay();
    h.secure.set(TOKEN_KEY, expiredToken());
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login')
        ? loginResponse(fresh)
        : json([{ id: 'host-a', name: 'Studio Mac', online: true }])
    ));
    vi.stubGlobal('fetch', transport);

    // No account argument: the persisted settings supply it.
    const hosts = await fetchRelayHosts(RELAY_URL);

    expect(hosts).toEqual([{ id: 'host-a', name: 'Studio Mac', online: true }]);
    expect(urlsOf(transport)).toEqual([`${RELAY_URL}/api/login`, `${RELAY_URL}/api/hosts`]);
    expect(authOf((transport.mock.calls[1] as unknown as [string, RequestInit])[1])).toBe(`Bearer ${fresh}`);
    expect(await getRelayToken()).toBe(fresh);
  });

  it('refreshes once on 401 and replays the host list request exactly once', async () => {
    setRelaySessionPassword('secret');
    // Opaque token: no `exp`, so the refresh is driven by the 401 itself.
    h.secure.set(TOKEN_KEY, 'opaque-token');
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/login')) return loginResponse(fresh);
      return authOf(init) === `Bearer ${fresh}`
        ? json([{ id: 'host-a', name: 'Studio Mac', online: true }])
        : json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', transport);

    await expect(fetchRelayHosts(RELAY_URL, ACCOUNT)).resolves.toHaveLength(1);

    expect(urlsOf(transport)).toEqual([
      `${RELAY_URL}/api/hosts`,
      `${RELAY_URL}/api/login`,
      `${RELAY_URL}/api/hosts`,
    ]);
  });

  it('refreshes once on 401 before fetching a host key', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'opaque-token');
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/login')) return loginResponse(fresh);
      return authOf(init) === `Bearer ${fresh}`
        ? json({ key_wrapped: '', key_salt: '', key_kdf: '' })
        : json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', transport);

    await expect(fetchHostKey(RELAY_URL, 'host-a', undefined, ACCOUNT)).resolves.toEqual({
      wrapped: '',
      salt: '',
      kdf: '',
    });

    expect(urlsOf(transport)).toEqual([
      `${RELAY_URL}/api/hosts/host-a/key`,
      `${RELAY_URL}/api/login`,
      `${RELAY_URL}/api/hosts/host-a/key`,
    ]);
  });

  it('raises relay_login_required when no password can mint a token', async () => {
    h.secure.set(TOKEN_KEY, 'opaque-token');
    const transport = vi.fn(async () => json({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', transport);

    const error = await fetchRelayHosts(RELAY_URL, ACCOUNT).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayLoginRequiredError);
    expect((error as RelayLoginRequiredError).code).toBe('relay_login_required');
    // No login round-trip is possible, so only the original request went out.
    expect(urlsOf(transport)).toEqual([`${RELAY_URL}/api/hosts`]);
    // D3: the persisted token is untouched; the user only has to re-enter the
    // account password, not sign out of the host.
    expect(await getRelayToken()).toBe('opaque-token');
    expect(h.tokenDeletes).toBe(0);
  });

  it('does not replay a second time when the refreshed token is also rejected', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'opaque-token');
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? loginResponse(futureToken()) : json({ error: 'unauthorized' }, 401)
    ));
    vi.stubGlobal('fetch', transport);

    const error = await fetchRelayHosts(RELAY_URL, ACCOUNT).catch((reason: unknown) => reason);

    expect(isRelayReauthRequired(error)).toBe(true);
    expect(urlsOf(transport)).toEqual([
      `${RELAY_URL}/api/hosts`,
      `${RELAY_URL}/api/login`,
      `${RELAY_URL}/api/hosts`,
    ]);
  });
});

describe('control-plane refresh failure classification', () => {
  // D3: the control plane classifies the same way as the data plane, so the
  // hosts screen can distinguish "enter the password again" from "offline"
  // without inventing its own mapping.
  it('maps missing_password to RelayLoginRequiredError and keeps the token', async () => {
    h.secure.set(TOKEN_KEY, expiredToken());
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);

    const error = await relayFetch(RELAY_URL, '/api/hosts').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayLoginRequiredError);
    expect((error as RelayLoginRequiredError).reason).toBe('missing_password');
    expect(transport).not.toHaveBeenCalled();
    expect(await getRelayToken()).toBeDefined();
    expect(h.tokenDeletes).toBe(0);
  });

  it('maps unreachable to RelayUnreachableError and keeps the token', async () => {
    setRelaySessionPassword('secret');
    persistRelay();
    h.secure.set(TOKEN_KEY, expiredToken());
    const transport = vi.fn(async () => { throw new TypeError('Network request failed'); });
    vi.stubGlobal('fetch', transport);

    const error = await relayFetch(RELAY_URL, '/api/hosts').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as RelayUnreachableError).code).toBe('relay_unreachable');
    expect((error as RelayUnreachableError).reason).toBe('unreachable');
    // Only the sign-in attempt went out; the host request never left.
    expect(urlsOf(transport)).toEqual([`${RELAY_URL}/api/login`]);
    expect(await getRelayToken()).toBeDefined();
    expect(h.tokenDeletes).toBe(0);
  });

  it('maps invalid_credentials to RelayReauthRequiredError and clears the session', async () => {
    setRelaySessionPassword('wrong');
    persistRelay();
    h.secure.set(TOKEN_KEY, expiredToken());
    const transport = vi.fn(async () => json({ error: 'invalid email or password' }, 401));
    vi.stubGlobal('fetch', transport);

    const error = await relayFetch(RELAY_URL, '/api/hosts').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayReauthRequiredError);
    expect((error as RelayReauthRequiredError).reason).toBe('invalid_credentials');
    expect(h.tokenDeletes).toBe(1);
    expect(await getRelayToken()).toBeUndefined();
  });
});
