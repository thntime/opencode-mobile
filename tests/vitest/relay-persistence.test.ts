import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConnectionProfiles, saveConnectionProfiles, toConnectionProfile } from '@/lib/connection-profiles';
import { withoutConnectionPassword } from '@/lib/connection-password';
import { parseConnectionSettings } from '@/providers/persisted-preferences';

// `relay` is an additive field on both the active connection settings and saved
// profiles. Old records must keep working as direct connections, and a corrupt
// relay block must be dropped instead of invalidating the whole record.
const h = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  secure: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => h.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { h.storage.set(key, value); },
    removeItem: async (key: string) => { h.storage.delete(key); },
  },
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
  getItemAsync: async (key: string) => h.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { h.secure.set(key, value); },
  deleteItemAsync: async (key: string) => { h.secure.delete(key); },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated-id' }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/lib/connect', () => ({
  parseConnectMetadata: () => undefined,
  getConnectCredentialError: () => undefined,
  getConnectTestSecret: () => '',
  setConnectTestSecret: () => undefined,
}));
vi.mock('@/providers/workspace-storage', () => ({
  WORKSPACES_STORAGE_KEY: 'opencode-mobile.workspaces',
  parseWorkspaces: (raw: string) => JSON.parse(raw),
}));
vi.mock('@/lib/opencode/client/types', () => ({
  defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '', password: '', directory: '' },
}));

const relay = {
  relayUrl: 'https://relay.example.test',
  account: 'alice@example.test',
  hostId: 'host-a',
  hostName: 'Studio Mac',
  tokenExpiresAt: 1_900_000_000_000,
};

beforeEach(() => {
  h.storage.clear();
  h.secure.clear();
});

describe('relay connection settings persistence', () => {
  it('round-trips the relay block through the persisted settings whitelist', () => {
    // Mirror the write-back path: the password is stripped, everything else
    // (including `relay`) is serialized as-is.
    const stored = JSON.stringify(withoutConnectionPassword({
      serverUrl: 'https://relay.example.test/relay/host-a',
      username: 'alice',
      password: 'host-secret',
      directory: '/repo',
      relay,
    }));
    const parsed = parseConnectionSettings(stored);

    expect(stored).not.toContain('host-secret');
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({
      serverUrl: 'https://relay.example.test/relay/host-a',
      username: 'alice',
      directory: '/repo',
      relay,
    });
  });

  it('drops an unknown or malformed relay block but keeps the direct connection', () => {
    for (const invalid of ['https://relay.example.test', ['relay'], {}, { relayUrl: '', account: 'a' }, { relayUrl: 5, account: 'a' }, { relayUrl: 'https://r', account: 5 }, { relayUrl: 'https://r', account: 'a', tokenExpiresAt: 'later' }]) {
      const parsed = parseConnectionSettings(JSON.stringify({ serverUrl: 'https://direct.example.test', username: 'alice', relay: invalid }));
      expect(parsed.serverUrl).toBe('https://direct.example.test');
      expect(parsed.username).toBe('alice');
      expect(parsed.relay).toBeUndefined();
    }
  });

  it('reads settings written before relay existed as a direct connection', () => {
    const parsed = parseConnectionSettings(JSON.stringify({ serverUrl: 'https://direct.example.test', username: 'alice', password: 'secret' }));
    expect(parsed.relay).toBeUndefined();
    expect(parsed.serverUrl).toBe('https://direct.example.test');
  });
});

describe('relay connection profiles', () => {
  it('keeps the relay block on a saved profile', async () => {
    const profile = { id: 'p1', name: 'Relay', serverUrl: 'https://relay.example.test/relay/host-a', username: 'alice', relay };
    await saveConnectionProfiles([profile]);

    const [loaded] = await loadConnectionProfiles();
    expect(loaded).toEqual(profile);
  });

  it('treats a legacy profile without relay as a direct connection', async () => {
    h.storage.set('opencode-mobile.connection-profiles', JSON.stringify([
      { id: 'legacy', name: 'Home', serverUrl: 'https://direct.example.test', username: 'alice' },
    ]));

    const [loaded] = await loadConnectionProfiles();
    expect(loaded).toEqual({ id: 'legacy', name: 'Home', serverUrl: 'https://direct.example.test', username: 'alice' });
    expect(loaded.relay).toBeUndefined();
  });

  it('drops a malformed relay block from a profile without dropping the profile', () => {
    const profile = toConnectionProfile({
      id: 'p1',
      name: 'Relay',
      serverUrl: 'https://relay.example.test/relay/host-a',
      username: 'alice',
      relay: { relayUrl: 'https://relay.example.test', account: 42 },
    });

    expect(profile).toEqual({ id: 'p1', name: 'Relay', serverUrl: 'https://relay.example.test/relay/host-a', username: 'alice' });
  });
});
