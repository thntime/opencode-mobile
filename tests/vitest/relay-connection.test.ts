import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPtyWebSocketUrl } from '@/lib/opencode/client';
import { createAuthHeader, fetchConnection, getRequestHeaders } from '@/lib/opencode/client/fetch';
import { ServiceManagementError, listManagedServices } from '@/lib/opencode/client/management';
import { getConnectionScope } from '@/lib/connection-scope';
import { clearRelayToken, getRelayToken } from '@/lib/relay/auth';
import { buildRelayServerUrl, normalizeRelayUrl } from '@/lib/relay/url';
import type { OpencodeConnectionSettings } from '@/lib/opencode/client/types';

const counters = vi.hoisted(() => ({ recordBytes: vi.fn(), recordRequest: vi.fn() }));
const h = vi.hoisted(() => ({ secure: new Map<string, string>() }));

vi.mock('@/lib/opencode/data-usage', () => counters);
vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async (key: string) => h.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { h.secure.set(key, value); },
  deleteItemAsync: async (key: string) => { h.secure.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock('@/lib/opencode/client/types', () => ({
  defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '', password: '', directory: '' },
}));

const TOKEN_KEY = 'opencode-mobile.relay-token';
const relayAuth = { relayUrl: 'https://relay.example.test', account: 'alice@example.test', hostId: 'host-a' };

function relaySettings(overrides: Partial<OpencodeConnectionSettings> = {}): OpencodeConnectionSettings {
  return {
    serverUrl: buildRelayServerUrl('https://relay.example.test', 'host-a'),
    username: 'alice',
    password: 'host-secret',
    directory: '',
    relay: relayAuth,
    ...overrides,
  };
}

function directSettings(): OpencodeConnectionSettings {
  return { serverUrl: 'https://direct.example.test', username: 'alice', password: 'direct-secret', directory: '' };
}

beforeEach(async () => {
  h.secure.clear();
  await clearRelayToken();
  counters.recordRequest.mockClear();
  counters.recordBytes.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay server URL derivation', () => {
  it('joins the relay base and host id without duplicate slashes', () => {
    expect(buildRelayServerUrl('https://relay.example.test', 'host-a')).toBe('https://relay.example.test/relay/host-a');
    expect(buildRelayServerUrl('https://relay.example.test/', '/host-a/')).toBe('https://relay.example.test/relay/host-a');
    expect(buildRelayServerUrl('https://relay.example.test///', 'host-a')).toBe('https://relay.example.test/relay/host-a');
    expect(buildRelayServerUrl('relay.example.test', 'host-a')).toBe('http://relay.example.test/relay/host-a');
    expect(normalizeRelayUrl(' https://relay.example.test/base/// ')).toBe('https://relay.example.test/base');
  });

  it('gives each host its own connection scope and keeps it stable per host', () => {
    const hostA = buildRelayServerUrl('https://relay.example.test', 'host-a');
    const hostB = buildRelayServerUrl('https://relay.example.test', 'host-b');

    expect(getConnectionScope({ serverUrl: hostA, username: 'alice' }))
      .toBe(getConnectionScope({ serverUrl: 'https://relay.example.test/relay/host-a/', username: 'alice' }));
    expect(getConnectionScope({ serverUrl: hostA, username: 'alice' }))
      .not.toBe(getConnectionScope({ serverUrl: hostB, username: 'alice' }));
  });
});

describe('relay authorization header', () => {
  it('keeps Basic auth for direct connections', () => {
    const settings = directSettings();
    expect(createAuthHeader(settings)).toBe(`Basic ${Buffer.from('alice:direct-secret').toString('base64')}`);
    expect(getRequestHeaders(settings)).toEqual({ Authorization: `Basic ${Buffer.from('alice:direct-secret').toString('base64')}` });
  });

  it('uses the SecureStore bearer token for relay connections', async () => {
    h.secure.set(TOKEN_KEY, 'relay-jwt');
    const settings = relaySettings();

    // The header is synchronous; the token cache is hydrated by the auth module
    // (and by fetchConnection below) before a client is built.
    expect(await getRelayToken()).toBe('relay-jwt');

    expect(createAuthHeader(settings)).toBe('Bearer relay-jwt');
    expect(getRequestHeaders(settings)).toEqual({ Authorization: 'Bearer relay-jwt' });
    expect(createAuthHeader(settings)).not.toContain('host-secret');
  });

  it('sends the bearer token and never the host credential, without logging it', async () => {
    h.secure.set(TOKEN_KEY, 'relay-jwt');
    const transport = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', transport);

    await fetchConnection('https://relay.example.test/relay/host-a/api/info', undefined, relaySettings());

    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer relay-jwt');
    expect(headers.get('Authorization')).not.toContain('Basic');
    expect(counters.recordRequest).toHaveBeenCalledTimes(1);
    // Usage logging records a count only: neither the URL query nor any header
    // (and therefore no token) reaches the diagnostic record.
    expect(counters.recordRequest.mock.calls[0]).toEqual([]);
    expect(JSON.stringify(counters.recordRequest.mock.calls)).not.toContain('relay-jwt');
  });

  it('leaves direct requests untouched (the client passes Basic via headers)', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', transport);

    await fetchConnection('https://direct.example.test/api/info', undefined, directSettings());

    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    // Direct connections keep the existing contract: auth is supplied by
    // `getRequestHeaders` at client construction, never injected per request.
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });
});

describe('relay terminal and service management paths', () => {
  it('keeps the relay prefix on the PTY WebSocket URL', () => {
    const url = new URL(buildPtyWebSocketUrl({ serverUrl: buildRelayServerUrl('https://relay.example.test', 'host-a'), directory: '/repo' }, 'pty-1'));

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/relay/host-a/api/pty/pty-1/connect');
    expect(url.searchParams.get('location[directory]')).toBe('/repo');
  });

  it('disables service management on a relay connection', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', transport);

    const error = await listManagedServices(relaySettings()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceManagementError);
    expect((error as ServiceManagementError).message).toMatch(/Relay/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps the server path prefix on Cloud Link management requests', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ services: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', transport);

    await listManagedServices({
      ...directSettings(),
      serverUrl: 'https://m.example.test/relay/host-a',
      connect: {
        controlPlaneUrl: 'https://api.example.test',
        machineId: 'machine-1',
        machineName: 'Mac',
        deviceId: 'alice',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

    const [url] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://m.example.test/relay/host-a/_cloudlink/services');
  });
});
