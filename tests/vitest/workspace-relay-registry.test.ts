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

function storedRecord(settings: Record<string, unknown>, name: string, projects = ['/repo']) {
  return {
    id: scopes.getConnectionUiScope(settings),
    name,
    settings,
    enabled: true,
    preferences: { autoApprove: false },
    projects,
  };
}

// Mounts the real registry hook with deterministic platform boundaries. The
// relay profile helpers are stubbed but `mutateConnectionProfiles` runs the
// operation so `switchConnection` gets a real profile back.
async function mountRegistry(options: { hydrated?: boolean; getItem?: () => Promise<string | null> } = {}) {
  const runtime = hookRuntime();
  const clearRelayConnectionState = vi.fn(async () => undefined);
  const { useWorkspaceConnections } = await loadTs('providers/use-workspace-connections.ts', {
    react: runtime.react,
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: options.getItem ?? (async () => null), setItem: async () => undefined } },
    '@/lib/connection-scope': scopes,
    '@/lib/connection-profiles': {
      createProfileId: () => 'new',
      findMatchingProfile: () => undefined,
      getProfilePassword: async () => '',
      loadConnectionProfiles: async () => [],
      mutateConnectionProfiles: async (operation: (profiles: unknown[], save: (profiles: unknown[]) => Promise<void>) => Promise<unknown>) => operation([], async () => undefined),
      saveProfilePassword: vi.fn(async () => undefined),
      deleteProfilePassword: vi.fn(async () => undefined),
      pickModelPreferences: () => ({}),
      clearRelayConnectionState,
    },
    '@/lib/opencode/client': { defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '' } },
    '@/lib/opencode/client/url': { getServerHostname: (value: string) => new URL(value).hostname },
    '@/lib/relay/url': { normalizeRelayUrl: (value: string) => value.trim().replace(/\/+$/, '') },
    '@/providers/persistence-hydration': { createPersistenceWriter: () => Object.assign(async () => {}, { preserveUnread: vi.fn() }) },
    '@/providers/shared-event-stream': { createSharedEventStream: () => () => {} },
    '@/providers/workspace-storage': { WORKSPACES_STORAGE_KEY: 'workspaces', parseWorkspaces: (raw: string) => JSON.parse(raw), serializeWorkspaces: () => 'stored' },
    '@/providers/workspace-types': { workspaceKey: ({ connectionId, projectPath }: { connectionId: string; projectPath: string }) => JSON.stringify([connectionId, projectPath]) },
  }, runtime.globals);
  const shell = {
    projectPathsByConnection: {},
    chatPreferences: {},
    onboardingVersion: 1,
    activeProjectPath: '',
    settings: DIRECT_SETTINGS,
    setSettings: vi.fn(),
  };
  runtime.mount(({ shell: value }: { shell: typeof shell }) => useWorkspaceConnections(value as never, options.hydrated ?? false), { shell });
  return { runtime, shell, clearRelayConnectionState };
}

const PENDING_RELAY = { ...RELAY_SETTINGS };

function relayHostSettings(hostId: string, account = ACCOUNT) {
  return {
    serverUrl: `${RELAY_URL}/relay/${hostId}`,
    username: '',
    password: '',
    directory: '',
    relay: { relayUrl: RELAY_URL, account, hostId, hostName: hostId },
  };
}

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
      '@/lib/relay/url': { normalizeRelayUrl: (value: string) => value.trim().replace(/\/+$/, '') },
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

describe('selecting a host upgrades the pending relay entry', () => {
  it('keeps only the host entry after login -> host selection', async () => {
    const { runtime } = await mountRegistry();
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    runtime.value.change(() => [direct]);
    runtime.value.enterRelayMode(PENDING_RELAY);
    runtime.flush();
    const pendingId = scopes.getConnectionUiScope(PENDING_RELAY);
    expect(runtime.value.connections.map((entry: { id: string }) => entry.id)).toEqual([direct.id, pendingId]);

    const host = relayHostSettings('host-a');
    const hostId = scopes.getConnectionUiScope(host);
    const switching = runtime.value.switchConnection(host);
    await runtime.settle();
    // The upgraded entry is what `ensure` waits for; publish its runtime so the
    // switch can finish instead of waiting for the production mount.
    const entry = runtime.value.connections.find((item: { id: string }) => item.id === hostId);
    expect(entry).toBeDefined();
    runtime.value.publish(JSON.stringify([hostId, entry.projects[0] ?? '']), {
      enabled: entry.enabled,
      native: { settings: entry.settings },
      suspend: vi.fn(),
      values: {
        projectsValue: { activeProjectPath: entry.projects[0] ?? '' },
        connectionValue: { connect: async () => ({ status: 'connected' }) },
      },
    });
    runtime.flush();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.fire(25);
      await runtime.settle();
    }
    await switching;

    expect(runtime.value.connections.map((item: { id: string }) => item.id)).toEqual([direct.id, hostId]);
    expect(runtime.value.connections.some((item: { id: string }) => item.id === pendingId)).toBe(false);
    expect(runtime.value.connections.find((item: { id: string }) => item.id === hostId)?.settings.relay).toMatchObject({ hostId: 'host-a' });
    runtime.unmount();
  });
});

describe('switching Relay account drops the previous account entries', () => {
  it('removes host and pending entries of another account', async () => {
    const { runtime } = await mountRegistry();
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    const oldHost = record(relayHostSettings('host-a', 'bob@example.test'), 'Old host');
    const oldPending = record({ ...PENDING_RELAY, relay: { relayUrl: RELAY_URL, account: 'bob@example.test' } }, 'Old relay', ['']);
    runtime.value.change(() => [direct, oldHost, oldPending]);
    runtime.flush();

    runtime.value.enterRelayMode(PENDING_RELAY);
    runtime.flush();

    const newId = scopes.getConnectionUiScope(PENDING_RELAY);
    expect(runtime.value.connections.map((entry: { id: string }) => entry.id)).toEqual([direct.id, newId]);
    // The direct profile is untouched: only the previous Relay account is stale.
    expect(runtime.value.connections[0]).toMatchObject({ id: direct.id, settings: DIRECT_SETTINGS });
    runtime.unmount();
  });

  // The real login screen writes through the focused runtime's `updateSettings`
  // (an id migration), not `enterRelayMode`; the same account isolation applies.
  it('removes the previous account entries through the updateSettings migration', async () => {
    const { runtime } = await mountRegistry();
    const direct = record(DIRECT_SETTINGS, 'Home LAN');
    const oldHost = record(relayHostSettings('host-a', 'bob@example.test'), 'Old host');
    runtime.value.change(() => [direct, oldHost]);
    runtime.value.select({ connectionId: direct.id, projectPath: '/repo' }, false);
    runtime.flush();

    runtime.value.updateSettings(direct.id, { ...PENDING_RELAY });
    runtime.flush();

    const newId = scopes.getConnectionUiScope(PENDING_RELAY);
    expect(runtime.value.connections.map((entry: { id: string }) => entry.id)).toEqual([newId]);
    expect(runtime.value.connections[0]).toMatchObject({ settings: { relay: PENDING_RELAY.relay } });
    runtime.unmount();
  });
});

describe('leaving Relay mode clears the session from the registry funnel', () => {
  it('clears the account session when the settings page switches to a direct profile', async () => {
    const { runtime, clearRelayConnectionState } = await mountRegistry();
    const relayHost = record(relayHostSettings('host-a'), 'Studio');
    runtime.value.change(() => [relayHost]);
    runtime.value.select({ connectionId: relayHost.id, projectPath: '' }, false);
    runtime.flush();

    // Settings-page `connectionProfiles.connect` goes straight to the manager;
    // it never passes through the runtime connect actions.
    void runtime.value.switchConnection({ serverUrl: 'http://192.168.1.10:4096', username: 'alice', password: 'secret' });
    await runtime.settle();

    expect(clearRelayConnectionState).toHaveBeenCalledTimes(1);
    const direct = runtime.value.connections.find((entry: { settings: { serverUrl: string } }) => entry.settings.serverUrl === 'http://192.168.1.10:4096');
    expect(direct?.settings.relay).toBeUndefined();
    runtime.unmount();
  });
});

describe('signing out keeps a disabled pending Relay entry', () => {
  it('migrates the host entry to a host-less Relay entry instead of an empty URL', async () => {
    const { runtime } = await mountRegistry();
    const relayHost = record(relayHostSettings('host-a'), 'Studio');
    runtime.value.change(() => [relayHost]);
    runtime.value.select({ connectionId: relayHost.id, projectPath: '' }, false);
    runtime.flush();

    runtime.value.updateSettings(relayHost.id, { ...PENDING_RELAY });
    runtime.flush();

    const pendingId = scopes.getConnectionUiScope(PENDING_RELAY);
    expect(runtime.value.connections).toHaveLength(1);
    expect(runtime.value.connections[0]).toMatchObject({
      id: pendingId,
      enabled: false,
      settings: { serverUrl: '', relay: PENDING_RELAY.relay },
    });
    // No entry is left with an empty URL and no Relay block to identify it.
    expect(runtime.value.connections[0].settings.relay).toBeDefined();
    runtime.unmount();
  });
});

describe('hydration does not overwrite a sign-in that landed first', () => {
  it('merges the stored registry with entries created before hydration', async () => {
    let release!: (value: string) => void;
    const stored = new Promise<string>((resolve) => { release = resolve; });
    const { runtime } = await mountRegistry({ hydrated: true, getItem: () => stored });
    const direct = storedRecord(DIRECT_SETTINGS, 'Home LAN');
    runtime.value.enterRelayMode(PENDING_RELAY);
    runtime.flush();

    release(JSON.stringify({ version: 1, connections: [direct], focus: { connectionId: direct.id, projectPath: '/repo' } }));
    await runtime.settle();

    const pendingId = scopes.getConnectionUiScope(PENDING_RELAY);
    expect(runtime.value.connections.map((entry: { id: string }) => entry.id)).toEqual([direct.id, pendingId]);
    expect(runtime.value.focus).toEqual({ connectionId: pendingId, projectPath: '' });
    runtime.unmount();
  });
});
