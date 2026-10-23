import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchConnection } from '@/lib/opencode/client/fetch';
import { decryptBody } from '@/lib/relay/crypto';
import { clearHostKeys, getHostKey, setHostKey } from '@/lib/relay/keywrap';
import {
  RelayHostAuthRequiredError,
  RelayLoginRequiredError,
  RelayReauthRequiredError,
  RelayUnreachableError,
  clearRelaySession,
  refreshRelayToken,
  resetRelayRefreshState,
} from '@/lib/relay/refresh';
import { clearRelayLoginRequired, relayLoginRequired } from '@/lib/relay/guard';
import { clearPassphrase, getPassphrase, setPassphrase } from '@/lib/relay/session-key';
import { clearRelaySessionPassword, setRelaySessionPassword } from '@/lib/relay/session-password';
import { clearRelayToken, getRelayToken } from '@/lib/relay/auth';
import { buildRelayServerUrl } from '@/lib/relay/url';
import type { OpencodeConnectionSettings } from '@/lib/opencode/client/types';

const counters = vi.hoisted(() => ({ recordBytes: vi.fn(), recordRequest: vi.fn() }));
const h = vi.hoisted(() => ({ secure: new Map<string, string>(), storage: new Map<string, string>(), tokenDeletes: 0 }));

vi.mock('@/lib/opencode/data-usage', () => counters);
vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async (key: string) => h.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { h.secure.set(key, value); },
  deleteItemAsync: async (key: string) => {
    // One token delete == one `clearRelaySession()`: the session cleanup always
    // goes through `clearRelayToken`.
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

function jwt(payload: Record<string, unknown>) {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.signature`;
}

function futureToken() {
  return jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 });
}

function relaySettings(overrides: Partial<OpencodeConnectionSettings> = {}): OpencodeConnectionSettings {
  return {
    serverUrl: buildRelayServerUrl(RELAY_URL, 'host-a'),
    username: 'alice',
    password: 'host-secret',
    directory: '',
    relay: { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a', hostName: 'Studio Mac' },
    ...overrides,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function loginResponse(token = futureToken()) {
  return json({ token, user: { email: ACCOUNT } });
}

function persistSettings(relay = { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a', hostName: 'Studio Mac', tokenExpiresAt: Date.now() - 60_000 }) {
  h.storage.set(SETTINGS_KEY, JSON.stringify({ serverUrl: buildRelayServerUrl(RELAY_URL, 'host-a'), username: 'alice', relay }));
}

beforeEach(async () => {
  h.secure.clear();
  h.storage.clear();
  clearHostKeys();
  clearPassphrase();
  counters.recordRequest.mockClear();
  counters.recordBytes.mockClear();
  resetRelayRefreshState();
  clearRelaySessionPassword();
  await clearRelayToken();
  clearRelayLoginRequired();
  h.tokenDeletes = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelayRefreshState();
  clearRelaySessionPassword();
  clearRelayLoginRequired();
});

describe('refreshRelayToken', () => {
  it('signs in again with the in-memory password and stores the fresh token', async () => {
    setRelaySessionPassword('secret');
    const token = futureToken();
    const transport = vi.fn(async () => loginResponse(token));
    vi.stubGlobal('fetch', transport);

    const result = await refreshRelayToken(RELAY_URL, ACCOUNT);

    expect(result).toMatchObject({ status: 'refreshed', token });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RELAY_URL}/api/login`);
    expect(JSON.parse(String(init.body))).toEqual({ email: ACCOUNT, password: 'secret' });
    expect(await getRelayToken()).toBe(token);
  });

  it('returns needs_reauth without any network call when no password is in memory', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    h.secure.set(TOKEN_KEY, 'stale-token');
    persistSettings();

    const result = await refreshRelayToken(RELAY_URL, ACCOUNT);

    expect(result).toEqual({ status: 'needs_reauth', reason: 'missing_password' });
    expect(transport).not.toHaveBeenCalled();
    // D3: a missing in-memory password is not a rejected credential. The token,
    // the host selection and the key material all survive; only the root guard
    // learns that the account password has to be entered again.
    expect(await getRelayToken()).toBe('stale-token');
    expect(h.tokenDeletes).toBe(0);
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toMatchObject({ hostId: 'host-a' });
    expect(relayLoginRequired()).toBe(true);
  });

  it('turns a rejected sign-in into needs_reauth and clears the persisted session', async () => {
    setRelaySessionPassword('wrong');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid email or password' }, 401)));
    h.secure.set(TOKEN_KEY, 'stale-token');
    persistSettings();

    const result = await refreshRelayToken(RELAY_URL, ACCOUNT);

    expect(result).toEqual({ status: 'needs_reauth', reason: 'invalid_credentials' });
    expect(await getRelayToken()).toBeUndefined();
    const persisted = JSON.parse(h.storage.get(SETTINGS_KEY) as string);
    expect(persisted.relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
  });

  it('shares one sign-in between concurrent refreshes', async () => {
    setRelaySessionPassword('secret');
    const transport = vi.fn(async () => loginResponse());
    vi.stubGlobal('fetch', transport);

    const [first, second] = await Promise.all([
      refreshRelayToken(RELAY_URL, ACCOUNT),
      refreshRelayToken(RELAY_URL, ACCOUNT),
    ]);

    expect(first).toEqual(second);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('clears everything through clearRelaySession', async () => {
    setRelaySessionPassword('secret');
    setPassphrase('unlock-me');
    setHostKey('host-a', new Uint8Array(32).fill(1));
    h.secure.set(TOKEN_KEY, 'stale-token');
    persistSettings();

    await clearRelaySession();

    expect(await getRelayToken()).toBeUndefined();
    // Key material from the old session must not survive a re-login.
    expect(getHostKey('host-a')).toBeUndefined();
    expect(getPassphrase()).toBeUndefined();
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
  });
});

describe('refresh failure classification', () => {
  // D3: the failure reason decides the error type and whether the session is
  // destroyed. Only a credential the Relay actually rejected may sign out.
  const cases = [
    {
      reason: 'missing_password' as const,
      error: RelayLoginRequiredError,
      code: 'relay_login_required',
      clears: 0,
      password: undefined,
      transport: () => { throw new TypeError('unused'); },
      loginCalls: 0,
    },
    {
      reason: 'unreachable' as const,
      error: RelayUnreachableError,
      code: 'relay_unreachable',
      clears: 0,
      password: 'secret',
      transport: () => { throw new TypeError('Network request failed'); },
      loginCalls: 1,
    },
    {
      reason: 'invalid_credentials' as const,
      error: RelayReauthRequiredError,
      code: 'relay_reauth_required',
      clears: 1,
      password: 'wrong',
      transport: () => json({ error: 'invalid email or password' }, 401),
      loginCalls: 1,
    },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.reason} to ${testCase.error.name} (${testCase.clears} session clear)`, async () => {
      if (testCase.password) setRelaySessionPassword(testCase.password);
      h.secure.set(TOKEN_KEY, 'expiring-token');
      setHostKey('host-a', new Uint8Array(32).fill(9));
      setPassphrase('unlock-me');
      persistSettings();
      const transport = vi.fn(async () => testCase.transport());
      vi.stubGlobal('fetch', transport);

      const error = await fetchConnection(
        `${RELAY_URL}/relay/host-a/api/info`,
        undefined,
        relaySettings({ relay: { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a', tokenExpiresAt: Date.now() - 1 } }),
      ).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(testCase.error);
      expect((error as { code?: string }).code).toBe(testCase.code);
      expect((error as { reason?: string }).reason).toBe(testCase.reason);
      expect(transport).toHaveBeenCalledTimes(testCase.loginCalls);
      expect(h.tokenDeletes).toBe(testCase.clears);
      if (testCase.clears === 0) {
        expect(await getRelayToken()).toBe('expiring-token');
        expect(getHostKey('host-a')).toBeDefined();
        expect(getPassphrase()).toBe('unlock-me');
        expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toMatchObject({ hostId: 'host-a' });
      } else {
        expect(await getRelayToken()).toBeUndefined();
        expect(getHostKey('host-a')).toBeUndefined();
        expect(getPassphrase()).toBeUndefined();
        expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
      }
      expect(relayLoginRequired()).toBe(testCase.reason === 'missing_password');
    });
  }
});

describe('fetchConnection relay refresh', () => {
  it('refreshes a token inside the five-minute window before sending the request', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expiring-token');
    persistSettings();
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/login')) return loginResponse(fresh);
      return json({ ok: true });
    });
    vi.stubGlobal('fetch', transport);

    const response = await fetchConnection(
      `${RELAY_URL}/relay/host-a/api/info`,
      undefined,
      relaySettings({ relay: { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a', tokenExpiresAt: Date.now() - 1 } }),
    );

    expect(response.status).toBe(200);
    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      `${RELAY_URL}/api/login`,
      `${RELAY_URL}/relay/host-a/api/info`,
    ]);
    expect(new Headers(calls[1][1].headers).get('Authorization')).toBe(`Bearer ${fresh}`);
    expect(await getRelayToken()).toBe(fresh);
  });

  it('refreshes once on 401 and replays the original request exactly once', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const fresh = futureToken();
    const body = JSON.stringify({ title: 'hello' });
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/login')) return loginResponse(fresh);
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === `Bearer ${fresh}` ? json({ id: 'ses_1' }) : json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', transport);

    const response = await fetchConnection(
      `${RELAY_URL}/relay/host-a/api/session`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      relaySettings(),
    );

    expect(response.status).toBe(200);
    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    expect(calls[1][0]).toBe(`${RELAY_URL}/api/login`);
    // The replay reuses the same body and swaps only the bearer token.
    expect(calls[0][1].body).toBe(body);
    expect(calls[2][1].body).toBe(body);
    expect(new Headers(calls[2][1].headers).get('Authorization')).toBe(`Bearer ${fresh}`);
    // One request before the refresh, one replay: never more than one replay.
    expect(counters.recordRequest).toHaveBeenCalledTimes(2);
  });

  it('does not refresh again when the replayed request is rejected with 401', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? loginResponse() : json({ error: 'unauthorized' }, 401)
    ));
    vi.stubGlobal('fetch', transport);
    persistSettings();

    const error = await fetchConnection(`${RELAY_URL}/relay/host-a/api/info`, undefined, relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayReauthRequiredError);
    expect((error as RelayReauthRequiredError).code).toBe('relay_reauth_required');
    // The data plane must report the replay rejection the same way the control
    // plane does, so callers can distinguish "session dead" from "refresh failed".
    expect((error as RelayReauthRequiredError).replayed).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(await getRelayToken()).toBeUndefined();
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
  });

  it('treats an upstream 401 challenge as a host auth problem and keeps the Relay session', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    // The Relay forwards upstream headers verbatim, so a Basic challenge means
    // the OpenCode host rejected the tunnel, not the Relay account.
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="opencode"' },
    }));
    vi.stubGlobal('fetch', transport);
    persistSettings();

    const error = await fetchConnection(`${RELAY_URL}/relay/host-a/api/info`, undefined, relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayHostAuthRequiredError);
    expect((error as RelayHostAuthRequiredError).code).toBe('relay_host_auth_required');
    expect((error as Error).message).toContain('主机要求认证');
    // No refresh, no replay, no session cleanup: the Relay token was never the problem.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await getRelayToken()).toBe('expired-token');
    expect(h.tokenDeletes).toBe(0);
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay.hostId).toBe('host-a');
  });

  it('keeps the session when the replayed request is challenged by the upstream host', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/login')) return loginResponse(fresh);
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === `Bearer ${fresh}`) {
        // The replay carries a valid Relay token, yet the host behind it still
        // asks for Basic credentials. That is a host configuration problem.
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="opencode"' },
        });
      }
      return json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', transport);
    persistSettings();

    const error = await fetchConnection(`${RELAY_URL}/relay/host-a/api/info`, undefined, relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayHostAuthRequiredError);
    expect((error as RelayHostAuthRequiredError).code).toBe('relay_host_auth_required');
    expect((error as Error).message).toContain('主机要求认证');
    expect(transport).toHaveBeenCalledTimes(3);
    // The fresh token and the host selection must survive the replay challenge.
    expect(await getRelayToken()).toBe(fresh);
    expect(h.tokenDeletes).toBe(0);
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay.hostId).toBe('host-a');
  });

  it('still treats a Relay 401 without a challenge as a dead session', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const fresh = futureToken();
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? loginResponse(fresh) : json({ error: 'unauthorized' }, 401)
    ));
    vi.stubGlobal('fetch', transport);
    persistSettings();

    const error = await fetchConnection(`${RELAY_URL}/relay/host-a/api/info`, undefined, relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayReauthRequiredError);
    expect((error as RelayReauthRequiredError).code).toBe('relay_reauth_required');
    expect((error as RelayReauthRequiredError).replayed).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(await getRelayToken()).toBeUndefined();
    expect(h.tokenDeletes).toBe(1);
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
  });

  it('raises relay_reauth_required and clears the session when the refresh fails', async () => {
    setRelaySessionPassword('wrong');
    h.secure.set(TOKEN_KEY, 'expired-token');
    // Dirty key material from the previous session: the failed re-auth must not
    // leave a host key or E2E passphrase behind for the next sign-in.
    setHostKey('host-a', new Uint8Array(32).fill(7));
    setPassphrase('unlock-me');
    persistSettings();
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? json({ error: 'nope' }, 401) : json({ error: 'unauthorized' }, 401)
    ));
    vi.stubGlobal('fetch', transport);

    const error = await fetchConnection(`${RELAY_URL}/relay/host-a/api/info`, undefined, relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayReauthRequiredError);
    expect((error as RelayReauthRequiredError).reason).toBe('invalid_credentials');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await getRelayToken()).toBeUndefined();
    expect(getHostKey('host-a')).toBeUndefined();
    expect(getPassphrase()).toBeUndefined();
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toEqual({ relayUrl: RELAY_URL, account: ACCOUNT });
  });

  it('fails before sending when the token is expiring and the password is gone', async () => {
    h.secure.set(TOKEN_KEY, 'expiring-token');
    persistSettings();
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);

    const error = await fetchConnection(
      `${RELAY_URL}/relay/host-a/api/info`,
      undefined,
      relaySettings({ relay: { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a', tokenExpiresAt: Date.now() - 1 } }),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayLoginRequiredError);
    expect((error as RelayLoginRequiredError).code).toBe('relay_login_required');
    expect((error as RelayLoginRequiredError).reason).toBe('missing_password');
    expect(transport).not.toHaveBeenCalled();
    // The persisted token is still valid: do not sign the user out or drop the
    // host just because the process lost the in-memory password.
    expect(await getRelayToken()).toBe('expiring-token');
    expect(JSON.parse(h.storage.get(SETTINGS_KEY) as string).relay).toMatchObject({ hostId: 'host-a' });
  });

  it('replays an encrypted body without encrypting it a second time', async () => {
    const key = new Uint8Array(32).fill(3);
    setHostKey('host-a', key);
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const fresh = futureToken();
    const plaintext = JSON.stringify({ message: '你好' });
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/login')) return loginResponse(fresh);
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === `Bearer ${fresh}` ? json({ ok: true }) : json({ error: 'unauthorized' }, 401);
    });
    vi.stubGlobal('fetch', transport);

    await fetchConnection(
      `${RELAY_URL}/relay/host-a/api/session`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: plaintext },
      relaySettings(),
    );

    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    const firstBody = calls[0][1].body as string;
    const replayBody = calls[2][1].body as string;
    expect(replayBody).toBe(firstBody);
    // The single base64 layer decrypts straight to the original JSON: a second
    // encryption pass would produce a body that fails here.
    expect(new TextDecoder().decode(decryptBody(replayBody, key))).toBe(plaintext);
    expect(new Headers(calls[2][1].headers).get('content-type')).toBe('application/json');
  });

  it('refuses to replay a streaming request body', async () => {
    setRelaySessionPassword('secret');
    h.secure.set(TOKEN_KEY, 'expired-token');
    const transport = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/api/login') ? loginResponse() : json({ error: 'unauthorized' }, 401)
    ));
    vi.stubGlobal('fetch', transport);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
      },
    });

    const error = await fetchConnection(
      `${RELAY_URL}/relay/host-a/api/upload`,
      { method: 'POST', body: stream as unknown as BodyInit },
      relaySettings(),
    ).catch((reason: unknown) => reason);

    expect((error as Error).message).toMatch(/cannot be replayed/i);
    // Original request + refresh sign-in, but no replay.
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
