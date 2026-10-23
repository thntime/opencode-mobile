import { describe, expect, it, vi } from 'vitest';

import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

// Workspace registry persistence for Relay sign-in. Before a host is chosen the
// entry has no `serverUrl`; its identity must still be stable and the registry
// must survive a relaunch (C1/4.5).
const scopes = await loadTs('lib/connection-scope.ts', {
  'base-64': { encode: (value: string) => Buffer.from(value, 'binary').toString('base64') },
});

const relayTypes = await loadTs('lib/relay/types.ts');
const parsing = await loadTs('providers/persisted-preferences.ts', {
  '@/lib/connect': { parseConnectMetadata: () => undefined },
  '@/lib/relay/types': relayTypes,
  '@/lib/opencode/client/url': { stripServerUrlCredentials: (value: string) => value.trim() },
  '@/providers/opencode-preferences': { normalizeTranscriptFontSize: (value: number) => value },
});
const storage = await loadTs('providers/workspace-storage.ts', {
  '@/lib/connection-password': { withoutConnectionPassword: ({ password: _password, ...value }: Record<string, unknown>) => value },
  '@/lib/connection-scope': scopes,
  '@/lib/opencode/client': { isValidServerUrl: (value: string) => /^https?:\/\//i.test(value) },
  '@/providers/persisted-preferences': parsing,
});

const RELAY_URL = 'https://relay.example.test';
const ACCOUNT = 'alice@example.test';
const RELAY_SETTINGS = {
  serverUrl: '',
  username: '',
  password: '',
  directory: '',
  relay: { relayUrl: RELAY_URL, account: ACCOUNT },
};
const DIRECT_SETTINGS = {
  serverUrl: 'https://direct.example.test',
  username: 'alice',
  password: 'direct-secret',
  directory: '',
};

function record(settings: Record<string, unknown>, name: string, projects = ['/repo']) {
  return {
    id: scopes.getConnectionUiScope(settings),
    name,
    settings,
    enabled: true,
    preferences: { autoApprove: false },
    projects,
    events: () => {},
  };
}

describe('relay workspace identity', () => {
  it('derives a stable account identity while no host is selected', () => {
    const pending = { serverUrl: '', username: '', relay: { relayUrl: 'https://Relay.Example.Test/', account: ' alice@example.test ' } };
    const same = { serverUrl: '', username: '', relay: { relayUrl: RELAY_URL, account: ACCOUNT } };
    const otherAccount = { serverUrl: '', username: '', relay: { relayUrl: RELAY_URL, account: 'bob@example.test' } };

    expect(scopes.getConnectionUiScope(pending)).toBe(scopes.getConnectionUiScope(same));
    expect(scopes.getConnectionUiScope(pending)).toBe(`relay:${RELAY_URL}:${ACCOUNT}`);
    expect(scopes.getConnectionUiScope(otherAccount)).not.toBe(scopes.getConnectionUiScope(same));
    // Once a host is chosen the canonical server+user scope keeps hosts apart.
    expect(scopes.getConnectionUiScope({
      serverUrl: `${RELAY_URL}/relay/host-a`,
      username: '',
      relay: { relayUrl: RELAY_URL, account: ACCOUNT, hostId: 'host-a' },
    })).toBe(scopes.getConnectionScope({ serverUrl: `${RELAY_URL}/relay/host-a`, username: '' }));
  });
});

describe('workspace registry round-trip with a pending relay entry', () => {
  it('persists and restores direct and relay entries side by side', () => {
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    const relay = record(RELAY_SETTINGS, 'Relay', ['']);
    const raw = storage.serializeWorkspaces([direct, relay], { connectionId: relay.id, projectPath: '' });

    expect(raw).not.toContain('direct-secret');
    const parsed = storage.parseWorkspaces(raw);

    expect(parsed.connections).toHaveLength(2);
    expect(parsed.connections.map((entry: { id: string }) => entry.id)).toEqual([direct.id, relay.id]);
    expect(parsed.connections[1].settings).toMatchObject({ serverUrl: '', username: '', relay: RELAY_SETTINGS.relay });
    expect(parsed.focus).toEqual({ connectionId: relay.id, projectPath: '' });
    // The direct profile is still recoverable after the relay sign-in.
    expect(parsed.connections[0].settings).toMatchObject({ serverUrl: 'https://direct.example.test', username: 'alice' });
  });

  it('skips a single corrupt entry instead of discarding the whole registry', () => {
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    const relay = record(RELAY_SETTINGS, 'Relay', ['']);
    const payload = JSON.parse(storage.serializeWorkspaces([direct, relay]));
    payload.connections.push({ ...direct, id: 'not-the-derived-identity', name: 'Corrupt' });

    const parsed = storage.parseWorkspaces(JSON.stringify(payload));
    expect(parsed.connections.map((entry: { name: string }) => entry.name)).toEqual(['Home LAN', 'Relay']);
  });

  it('falls back when every entry is unusable', () => {
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    const payload = JSON.parse(storage.serializeWorkspaces([direct]));
    payload.connections = [{ ...direct, id: 'wrong' }];
    expect(() => storage.parseWorkspaces(JSON.stringify(payload))).toThrow();
  });
});

describe('entering relay mode keeps the direct workspace', () => {
  it('adds a relay entry without rewriting the focused direct connection', async () => {
    const runtime = hookRuntime();
    const { useWorkspaceConnections } = await loadTs('providers/use-workspace-connections.ts', {
      react: runtime.react,
      '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => undefined } },
      '@/lib/connection-scope': scopes,
      '@/lib/connection-profiles': {
        createProfileId: () => 'new', findMatchingProfile: () => undefined, getProfilePassword: async () => '',
        loadConnectionProfiles: async () => [], mutateConnectionProfiles: vi.fn(), saveProfilePassword: vi.fn(),
        deleteProfilePassword: vi.fn(), pickModelPreferences: () => ({}),
      },
      '@/lib/opencode/client': { defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '' } },
      '@/lib/opencode/client/url': { getServerHostname: (value: string) => new URL(value).hostname },
      '@/providers/persistence-hydration': { createPersistenceWriter: () => Object.assign(async () => {}, { preserveUnread: vi.fn() }) },
      '@/providers/shared-event-stream': { createSharedEventStream: () => () => {} },
      '@/providers/workspace-storage': { WORKSPACES_STORAGE_KEY: 'workspaces', parseWorkspaces: () => ({ connections: [] }), serializeWorkspaces: () => 'stored' },
      '@/providers/workspace-types': { workspaceKey: ({ connectionId, projectPath }: { connectionId: string; projectPath: string }) => JSON.stringify([connectionId, projectPath]) },
    }, runtime.globals);

    const shell = {
      projectPathsByConnection: {},
      chatPreferences: {},
      onboardingVersion: 0,
      activeProjectPath: '',
      setSettings: vi.fn(),
    };
    runtime.mount(({ shell: value }: { shell: typeof shell }) => useWorkspaceConnections(value as never, false), { shell });

    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    runtime.value.change(() => [direct]);
    runtime.flush();
    const relaySettings = { ...RELAY_SETTINGS };
    runtime.value.enterRelayMode(relaySettings);
    runtime.flush();

    const relayId = scopes.getConnectionUiScope(relaySettings);
    expect(runtime.value.connections).toHaveLength(2);
    expect(runtime.value.connections[0]).toMatchObject({ id: direct.id, enabled: true, projects: ['/repo'] });
    expect(runtime.value.connections[1]).toMatchObject({ id: relayId, settings: relaySettings, enabled: true });
    expect(runtime.value.focus).toEqual({ connectionId: relayId, projectPath: '' });
    expect(shell.setSettings).toHaveBeenCalledWith(relaySettings);
  });
});
