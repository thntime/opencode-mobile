import { describe, expect, it, vi } from 'vitest';

import { RelayE2EError } from '@/lib/relay/errors';
import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Element['props']) => ({ type, props });

function find(root: Element | Element[] | string | undefined, predicate: (value: Element) => boolean): Element | undefined {
  if (!root || typeof root !== 'object') return undefined;
  if (Array.isArray(root)) {
    for (const child of root) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (predicate(root)) return root;
  return find(root.props?.children, predicate);
}

function findByTestId(root: Element | Element[] | string | undefined, testID: string) {
  return find(root, (value) => value.props?.testID === testID || value.type === testID);
}

const RELAY_URL = 'https://relay.example.test';
const ACCOUNT = 'alice@example.test';
const HOST = { id: 'host-a', name: 'Studio Mac', online: true };
const translate = (key: string) => key;
const translation = { useTranslation: () => ({ t: translate }) };

async function loadDialog(runtime: ReturnType<typeof hookRuntime>) {
  return loadTs('components/relay/relay-passphrase-dialog.tsx', {
    react: runtime.react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-i18next': translation,
    'react-native': { StyleSheet: { create: (styles: unknown) => styles }, View: 'View' },
    'react-native-paper': { Button: 'Button', HelperText: 'HelperText', Text: 'Text' },
    '@/components/ui/overlay-sheet': { OverlaySheet: 'OverlaySheet' },
    '@/components/ui/text-input': { TextInput: 'TextInput' },
    '@/constants/theme': { Colors: { light: {} } },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    '@/lib/relay/errors': { RelayE2EError, isRelayE2EError: (value: unknown) => value instanceof RelayE2EError },
  });
}

async function mountHosts(options: { unlockError?: unknown; fetchError?: unknown; hostKey?: unknown; switchResult?: unknown } = {}) {
  const runtime = hookRuntime();
  const dialog = await loadDialog(runtime);
  const updateSettings = vi.fn();
  const replace = vi.fn();
  const logout = vi.fn(async () => undefined);
  const clearRelayConnectionState = vi.fn(async () => undefined);
  const fetchRelayHosts = vi.fn(async () => {
    if (options.fetchError) throw options.fetchError;
    return [HOST];
  });
  const unlockHostKey = vi.fn(async () => {
    if (options.unlockError) throw options.unlockError;
    return new Uint8Array(32);
  });
  const fetchHostKey = vi.fn(async () => options.hostKey ?? ({ wrapped: 'wrapped-key', salt: 'salt', kdf: 'scrypt' }));
  const switchConnection = vi.fn(async () => options.switchResult ?? ({ status: 'connected' }));
  const router = { replace, back: vi.fn(), canGoBack: () => false };
  const settings = { relay: { relayUrl: RELAY_URL, account: ACCOUNT } };
  const connection = { settings, updateSettings, switchConnection };
  const onboarding = { onboardingCompleted: true, onboardingActive: false };
  const insets = { top: 0, bottom: 0 };
  const module = await loadTs('app/relay-hosts.tsx', {
    react: runtime.react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'expo-router': { useRouter: () => router },
    'react-i18next': translation,
    'react-native': { StyleSheet: { create: (styles: unknown) => styles }, View: 'View' },
    'react-native-paper': { Appbar: { Header: 'Header', Content: 'Content' }, HelperText: 'HelperText', Text: 'Text' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    '@/components/relay/relay-host-list': { RelayHostList: 'RelayHostList' },
    '@/components/relay/relay-passphrase-dialog': dialog,
    '@/constants/theme': { Colors: { light: {} } },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    '@/lib/connection-profiles': { clearRelayConnectionState },
    '@/lib/relay/auth': { logout },
    '@/lib/relay/errors': { isRelayE2EError: (value: unknown, code?: string) => (value as { code?: string })?.code === code },
    '@/lib/relay/hosts': { fetchRelayHosts },
    '@/lib/relay/keywrap': { clearHostKeys: vi.fn(), fetchHostKey, getHostKey: () => undefined, unlockHostKey },
    '@/lib/relay/refresh': {
      isRelayReauthRequired: (value: unknown) => (value as { code?: string })?.code === 'relay_reauth_required',
      isRelayLoginRequired: (value: unknown) => (value as { code?: string })?.code === 'relay_login_required',
      isRelayUnreachable: (value: unknown) => (value as { code?: string })?.code === 'relay_unreachable',
    },
    '@/lib/relay/session-key': { clearPassphrase: vi.fn() },
    '@/lib/relay/url': { buildRelayServerUrl: (base: string, hostId: string) => `${base}/relay/${hostId}` },
    '@/providers/opencode-contexts': {
      useConnection: () => connection,
      useOnboarding: () => onboarding,
    },
  }, runtime.globals);

  runtime.mount(module.default, {});
  await runtime.settle();
  return { runtime, dialog, updateSettings, replace, logout, clearRelayConnectionState, fetchRelayHosts, unlockHostKey, fetchHostKey, switchConnection };
}

async function openUnlockDialog(view: Awaited<ReturnType<typeof mountHosts>>) {
  const list = find(view.runtime.value, (value) => value.type === 'RelayHostList');
  if (!list) throw new Error('Missing RelayHostList');
  list.props.onSelect(HOST);
  await view.runtime.settle();
  const dialogElement = find(view.runtime.value, (value) => value.type === view.dialog.RelayPassphraseDialog);
  if (!dialogElement) throw new Error('Missing RelayPassphraseDialog');
  return dialogElement;
}

async function submitUnlock(dialogElement: Element) {
  // Render the real dialog with the screen's `handleUnlock` closure so the
  // mapping decision under test is exercised end to end.
  const dialogRuntime = hookRuntime();
  const dialog = await loadDialog(dialogRuntime);
  dialogRuntime.mount(dialog.RelayPassphraseDialog, dialogElement.props);
  const input = findByTestId(dialogRuntime.value, 'relay-passphrase-input');
  if (!input) throw new Error('Missing passphrase input');
  input.props.onChangeText('correct horse');
  dialogRuntime.flush();
  const submit = findByTestId(dialogRuntime.value, 'relay-passphrase-submit');
  if (!submit) throw new Error('Missing submit button');
  submit.props.onPress();
  await dialogRuntime.settle();
  const error = findByTestId(dialogRuntime.value, 'relay-passphrase-error');
  return error?.props.children as string | undefined;
}

describe('relay unlock error mapping (from handleUnlock)', () => {
  const cases: [string, unknown, string][] = [
    ['wrong passphrase', new RelayE2EError('relay_e2e_bad_passphrase', 'bad'), 'relay:unlock.badPassphrase'],
    ['unusable key material', new RelayE2EError('relay_e2e_key_unavailable', 'key'), 'relay:unlock.keyFormat'],
    ['relay unavailable', new RelayE2EError('relay_e2e_unavailable', 'offline'), 'relay:unlock.network'],
    ['relay rejected the account', new RelayE2EError('relay_e2e_unauthorized', 'auth', 403), 'relay:unlock.unauthorized'],
    ['upstream 503 folded into key_unavailable', new RelayE2EError('relay_e2e_key_unavailable', 'upstream', 503), 'relay:unlock.network'],
    // M5: a missing in-memory account password is not a transport failure.
    ['account password required again', { code: 'relay_login_required' }, 'relay:unlock.unauthorized'],
  ];

  it.each(cases)('%s renders its own message', async (_name, unlockError, expectedKey) => {
    const view = await mountHosts({ unlockError });
    const dialogElement = await openUnlockDialog(view);
    expect(await submitUnlock(dialogElement)).toBe(expectedKey);
  });
});

describe('relay host list failures', () => {
  it('renders a network-specific message for an unreachable Relay', async () => {
    const view = await mountHosts({ fetchError: { code: 'relay_unreachable' } });
    expect(findByTestId(view.runtime.value, 'relay-hosts-error')?.props.children).toBe('relay:hosts.unreachable');
  });

  it('renders a login-specific message when the password is needed again', async () => {
    const view = await mountHosts({ fetchError: { code: 'relay_login_required' } });
    expect(findByTestId(view.runtime.value, 'relay-hosts-error')?.props.children).toBe('relay:hosts.loginRequired');
  });

  // M4: a generic load failure and a host-selection failure must be
  // distinguishable by testID, so one cannot mask the other.
  it('keeps load and selection failures on separate testIDs', async () => {
    const loadView = await mountHosts({ fetchError: new Error('boom') });
    expect(findByTestId(loadView.runtime.value, 'relay-hosts-load-error')).toBeDefined();
    expect(findByTestId(loadView.runtime.value, 'relay-host-select-error')).toBeUndefined();

    const selectView = await mountHosts({
      hostKey: {},
      switchResult: { status: 'error', kind: 'host-auth', message: 'boom' },
    });
    const list = find(selectView.runtime.value, (value) => value.type === 'RelayHostList');
    list!.props.onSelect(HOST);
    await selectView.runtime.settle();
    expect(findByTestId(selectView.runtime.value, 'relay-host-select-error')).toBeDefined();
    expect(findByTestId(selectView.runtime.value, 'relay-hosts-load-error')).toBeUndefined();
  });

  // M6: an account the Relay forbids must not navigate into the tabs with a
  // dead connection; the host list explains why and stays usable.
  it('stays on the host list and shows the reason for a Relay 403', async () => {
    const view = await mountHosts({
      hostKey: {},
      switchResult: { status: 'error', kind: 'forbidden', message: 'Relay 拒绝了该账号的访问（403）' },
    });
    const list = find(view.runtime.value, (value) => value.type === 'RelayHostList');
    list!.props.onSelect(HOST);
    await view.runtime.settle();

    expect(findByTestId(view.runtime.value, 'relay-host-select-error')?.props.children).toBe('Relay 拒绝了该账号的访问（403）');
    expect(view.replace).not.toHaveBeenCalled();
  });

  it('keeps the Relay account for pre-fill and drops the host when signing out', async () => {
    const view = await mountHosts({ fetchError: { code: 'relay_reauth_required' } });
    await view.runtime.settle();

    expect(view.clearRelayConnectionState).toHaveBeenCalledTimes(1);
    expect(view.logout).toHaveBeenCalledTimes(1);
    // M1: rewriting the focused entry with an empty URL produced an invalid
    // record. Keeping the account lets /relay-login pre-fill the form.
    expect(view.updateSettings).toHaveBeenCalledWith({
      relay: { relayUrl: RELAY_URL, account: ACCOUNT },
      serverUrl: '',
      username: '',
      password: undefined,
      connect: undefined,
    });
    expect(view.replace).toHaveBeenCalledWith('/relay-login');
  });
});
