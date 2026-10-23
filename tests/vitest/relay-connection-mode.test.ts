import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchConnection } from '@/lib/opencode/client/fetch';
import { classifyConnectionFailure, getConnectionError } from '@/lib/opencode/client/errors';
import { clearRelayToken } from '@/lib/relay/auth';
import { isRelayConnectionTarget, relayModeSettings } from '@/lib/relay/connection-mode';
import { RelayForbiddenError } from '@/lib/relay/refresh';
import { buildRelayServerUrl } from '@/lib/relay/url';
import type { OpencodeConnectionSettings } from '@/lib/opencode/client/types';
import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

const counters = vi.hoisted(() => ({ recordBytes: vi.fn(), recordRequest: vi.fn() }));

vi.mock('@/lib/opencode/data-usage', () => counters);
vi.mock('@/lib/connect', () => ({ getCredentialError: () => undefined, getConnectCredentialError: () => undefined }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async () => 'jwt-token',
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const RELAY_URL = 'https://relay.example.test';
const HOST_ID = 'host-a';

function relayAuth(overrides: Partial<{ hostId: string }> = {}) {
  return { relayUrl: RELAY_URL, account: 'alice@example.test', hostId: HOST_ID, ...overrides };
}

function relaySettings(overrides: Partial<OpencodeConnectionSettings> = {}): OpencodeConnectionSettings {
  return {
    serverUrl: buildRelayServerUrl(RELAY_URL, HOST_ID),
    username: '',
    password: '',
    directory: '',
    relay: relayAuth(),
    ...overrides,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

type Element = { type?: unknown; props?: Record<string, any> };

function findByType(root: Element | Element[] | undefined, type: string): Element | undefined {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!root || typeof root !== 'object') return undefined;
  if (root.type === type) return root;
  return findByType(root.props?.children, type);
}

beforeEach(async () => {
  await clearRelayToken();
  counters.recordRequest.mockClear();
  counters.recordBytes.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay connection mode', () => {
  it('entering Relay mode clears the direct connection fields', () => {
    expect(relayModeSettings({ relayUrl: RELAY_URL, account: 'alice@example.test' })).toEqual({
      relay: { relayUrl: RELAY_URL, account: 'alice@example.test' },
      serverUrl: '',
      username: '',
      password: undefined,
      connect: undefined,
    });
  });

  it('accepts only the derived {relayUrl}/relay/{hostId} target', () => {
    expect(isRelayConnectionTarget(buildRelayServerUrl(RELAY_URL, HOST_ID), relayAuth())).toBe(true);
    expect(isRelayConnectionTarget(`${buildRelayServerUrl(RELAY_URL, HOST_ID)}/`, relayAuth())).toBe(true);
    expect(isRelayConnectionTarget('https://direct.example.test', relayAuth())).toBe(false);
    expect(isRelayConnectionTarget(buildRelayServerUrl(RELAY_URL, 'host-b'), relayAuth())).toBe(false);
    // No host selected yet (right after signing in).
    expect(isRelayConnectionTarget('', { relayUrl: RELAY_URL, account: 'alice@example.test' })).toBe(false);
  });

  it('compares canonical spellings so case, trailing slash and default port do not reject a host', () => {
    expect(isRelayConnectionTarget('HTTPS://RELAY.EXAMPLE.TEST:443/relay/host-a/', relayAuth())).toBe(true);
    expect(isRelayConnectionTarget('https://relay.example.test:443/relay/host-a', relayAuth())).toBe(true);
  });

  it('signing in again with the same account keeps the selected host', () => {
    const previous = { relay: { relayUrl: RELAY_URL, account: 'alice@example.test', hostId: HOST_ID, hostName: 'Studio Mac' } };
    expect(relayModeSettings({ relayUrl: `${RELAY_URL}/`, account: 'alice@example.test', tokenExpiresAt: 1_900_000_000_000 }, previous)).toEqual({
      relay: { relayUrl: `${RELAY_URL}/`, account: 'alice@example.test', tokenExpiresAt: 1_900_000_000_000, hostId: HOST_ID, hostName: 'Studio Mac' },
      serverUrl: buildRelayServerUrl(RELAY_URL, HOST_ID),
      username: '',
      password: undefined,
      connect: undefined,
    });
    // A different account must not inherit the previous host.
    expect(relayModeSettings({ relayUrl: RELAY_URL, account: 'bob@example.test' }, previous)).toMatchObject({
      relay: { relayUrl: RELAY_URL, account: 'bob@example.test' },
      serverUrl: '',
    });
  });
});

describe('relay request target guard', () => {
  it('refuses a leftover direct address without sending anything', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);

    const error = await fetchConnection(
      'https://direct.example.test/api/info',
      undefined,
      relaySettings({ serverUrl: 'https://direct.example.test' }),
    ).catch((reason: unknown) => reason);

    expect((error as Error).message).toMatch(/select a relay host/i);
    expect(transport).not.toHaveBeenCalled();
    expect(counters.recordRequest).not.toHaveBeenCalled();
  });

  it('refuses to probe before a host is selected', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);

    const error = await fetchConnection(
      'https://relay.example.test/api/info',
      undefined,
      relaySettings({ serverUrl: '', relay: { relayUrl: RELAY_URL, account: 'alice@example.test' } }),
    ).catch((reason: unknown) => reason);

    expect((error as Error).message).toMatch(/select a relay host/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends the request when the target matches the selected host', async () => {
    const transport = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', transport);

    const response = await fetchConnection(`${buildRelayServerUrl(RELAY_URL, HOST_ID)}/api/info`, undefined, relaySettings());

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('relay HTTP failure semantics', () => {
  // D4: relay status codes are translated where the relay response is received,
  // before the generic `errors.ts` mapping can call them "endpoint not found".
  it('keeps a Relay 403 out of the auth classification so the host is not dropped', async () => {
    const settings = relaySettings();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'forbidden' }, 403)));

    const error = await fetchConnection(`${buildRelayServerUrl(RELAY_URL, HOST_ID)}/api/info`, undefined, settings)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RelayForbiddenError);
    expect(classifyConnectionFailure(error)).toBe('forbidden');
    expect(classifyConnectionFailure(error)).not.toBe('auth');
  });

  const cases = [
    { status: 403, message: /Relay 拒绝了该账号的访问（403）/ },
    { status: 502, message: /Relay 上游不可达（502）/ },
    { status: 503, message: /Relay 上游不可达（503）/ },
    { status: 504, message: /Relay 上游不可达（504）/ },
  ];

  for (const testCase of cases) {
    it(`surfaces ${testCase.status} as a relay error instead of an endpoint mismatch`, async () => {
      const settings = relaySettings();
      const transport = vi.fn(async () => json({ error: 'upstream' }, testCase.status));
      vi.stubGlobal('fetch', transport);

      const error = await fetchConnection(`${buildRelayServerUrl(RELAY_URL, HOST_ID)}/api/info`, undefined, settings)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(testCase.message);
      expect((error as Error).message).not.toMatch(/OpenCode endpoint not found/i);
      // The user-facing mapping keeps the relay message verbatim.
      expect(getConnectionError(settings.serverUrl, error)).toMatch(testCase.message);
      expect(getConnectionError(settings.serverUrl, error)).not.toMatch(/OpenCode endpoint not found/i);
    });
  }
});

describe('relay sign-in settings', () => {
  it('writes the relay block and clears the direct connection fields on submit', async () => {
    const runtime = hookRuntime();
    const updateSettings = vi.fn();
    const replace = vi.fn();
    const module = await loadTs('app/relay-login.tsx', {
      react: runtime.react,
      'react/jsx-runtime': { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }), Fragment: 'Fragment' },
      'expo-router': { useRouter: () => ({ replace, back: vi.fn(), canGoBack: () => false }) },
      'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
      'react-native': {
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        ScrollView: 'ScrollView',
        StyleSheet: { create: (styles: unknown) => styles },
        View: 'View',
      },
      'react-native-paper': { Appbar: { Header: 'Header', BackAction: 'BackAction', Content: 'Content' }, Text: 'Text' },
      'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
      '@/components/relay/relay-login-form': { RelayLoginForm: 'RelayLoginForm' },
      '@/constants/theme': { Colors: { light: {}, dark: {} } },
      '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
      '@/lib/relay/url': { normalizeRelayUrl: (value: string) => value.replace(/\/+$/, '') },
      '@/lib/relay/connection-mode': { relayModeSettings },
      '@/lib/relay/guard': { clearRelayLoginRequired: vi.fn() },
      '@/providers/opencode-contexts': {
        useConnection: () => ({ settings: {}, updateSettings }),
        useOnboarding: () => ({ onboardingCompleted: true, onboardingActive: false }),
      },
    }, { Error });

    runtime.mount(module.default);
    const relayForm = findByType(runtime.value, 'RelayLoginForm');
    expect(relayForm).toBeDefined();
    await relayForm!.props!.onSubmit({ relayUrl: `${RELAY_URL}/`, account: 'alice@example.test' });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    const patch = updateSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.relay).toEqual({ relayUrl: RELAY_URL, account: 'alice@example.test' });
    expect(patch.serverUrl).toBe('');
    expect(patch.username).toBe('');
    expect(patch.password).toBeUndefined();
    expect(patch.connect).toBeUndefined();
    expect(replace).toHaveBeenCalledWith('/relay-hosts');
  });
});

describe('profile switching leaves Relay mode', () => {
  async function mountActions(initialSettings: OpencodeConnectionSettings) {
    const runtime = hookRuntime();
    const clearRelayConnectionState = vi.fn(async () => undefined);
    const ref = (current: unknown) => ({ current });
    const module = await loadTs('providers/use-connection-connect-actions.ts', {
      react: runtime.react,
      'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) } },
      '@/lib/connection-profiles': {
        findMatchingProfile: () => undefined,
        loadConnectionProfiles: async () => [],
        pickModelPreferences: () => ({}),
        mutateConnectionProfiles: async () => undefined,
        clearRelayConnectionState,
      },
      '@/lib/connect': { getConnectCredentialError: () => undefined },
      '@/lib/relay/auth': { getRelayToken: async () => undefined },
      '@/lib/relay/refresh': {
        isRelayReauthRequired: () => false,
        refreshRelayToken: async () => ({ status: 'needs_reauth', reason: 'invalid_credentials' }),
        relayWithoutHost: (relay: { relayUrl: string; account: string }) => ({ relayUrl: relay.relayUrl, account: relay.account }),
      },
      '@/lib/opencode/client': {
        buildClient: (settings: unknown) => ({ settings }),
        classifyConnectionFailure: () => 'unknown',
        detectServerContract: async () => ({ contract: 'v2' }),
        getConnectionError: (_url: string, error: Error) => error.message,
        getNormalizedServerUrl: (url: string) => url,
        isContractMismatchError: () => false,
        isAuthConnectionFailure: () => false,
        isRetryableCloudLinkStartupError: () => false,
        isValidServerUrl: () => true,
      },
    }, { Error });

    const input = {
      isHydrated: true,
      settingsRef: ref(initialSettings),
      connectionRef: ref({ status: 'idle', message: '' }),
      activeProjectPathRef: ref(undefined),
      serverGenerationRef: ref(0),
      scopeGenerationRef: ref(0),
      catalogGenerationRef: ref(new WeakMap()),
      serverContractRef: ref('v2'),
      serverProjectsRef: ref([]),
      initialConnectStartedRef: ref(false),
      chatPreferencesRef: ref({ enabledModelIds: [], recentModelIds: [], providerModelSelections: {} }),
      clearProjectState: () => undefined,
      softResetProjectState: () => undefined,
      isCurrentCatalogClient: () => true,
      loadProjectCatalog: async () => ({ serverProjects: [], serverRootPath: '/repo' }),
    } as Record<string, unknown>;
    for (const key of [
      'setServerProjects', 'setCurrentProjectPath', 'setServerRootPath', 'setSessions', 'setSessionStatuses',
      'setCurrentConfig', 'setAvailableProviders', 'setProviderAuthMethodsById', 'setAvailableModels',
      'setAvailableAgents', 'setChatPreferences', 'setDiagnostics', 'setSendingState', 'setActiveProjectPath',
      'setConnection', 'setServerContract',
    ]) input[key] = () => undefined;

    runtime.mount(() => {
      const [settings, setSettings] = runtime.react.useState(initialSettings);
      const [connection, setConnection] = runtime.react.useState({ status: 'idle', message: '' });
      const refs = input as {
        settingsRef: { current: unknown };
        connectionRef: { current: unknown };
      };
      runtime.react.useLayoutEffect(() => {
        refs.settingsRef.current = settings;
        refs.connectionRef.current = connection;
      });
      return {
        ...module.useConnectionConnectActions({
          ...input,
          settings,
          setSettings,
          connection,
          setConnection,
          activeProjectPath: undefined,
          connectSetup: { phase: 'idle', prepareSettings: async (value: unknown) => value },
        }),
        settings,
        connection,
      };
    }, {});

    return { runtime, clearRelayConnectionState };
  }

  it('clears the relay block and session when switching to a direct profile', async () => {
    const { runtime, clearRelayConnectionState } = await mountActions({
      ...relaySettings(),
      password: 'host-secret',
    });

    await runtime.value.switchConnection({ serverUrl: 'http://192.168.1.10:4096', username: 'alice', password: 'secret' });
    await runtime.settle();

    expect(clearRelayConnectionState).toHaveBeenCalledTimes(1);
    expect(runtime.value.settings.relay).toBeUndefined();
    expect(runtime.value.settings.serverUrl).toBe('http://192.168.1.10:4096');
  });

  it('keeps the relay session when switching between relay hosts', async () => {
    const { runtime, clearRelayConnectionState } = await mountActions(relaySettings());
    const nextRelay = relayAuth({ hostId: 'host-b' });

    await runtime.value.switchConnection({
      serverUrl: buildRelayServerUrl(RELAY_URL, 'host-b'),
      username: '',
      password: '',
      relay: nextRelay,
    });
    await runtime.settle();

    expect(clearRelayConnectionState).not.toHaveBeenCalled();
    expect(runtime.value.settings.relay).toEqual(nextRelay);
  });
});
