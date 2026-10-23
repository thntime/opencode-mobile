import { describe, expect, it, vi } from 'vitest';

import { RelayE2EError, isRelayE2EError } from '@/lib/relay/errors';
import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

type Element = { type: unknown; props: Record<string, any> };
type DialogError = 'badPassphrase' | 'keyFormat' | 'network' | 'unauthorized' | 'unavailable';
const element = (type: unknown, props: Element['props']) => ({ type, props });

function find(root: Element | Element[] | string, testID: string): Element | undefined {
  if (!root || typeof root !== 'object') return undefined;
  if (Array.isArray(root)) {
    for (const child of root) {
      const match = find(child, testID);
      if (match) return match;
    }
    return undefined;
  }
  if (root.props?.testID === testID || root.type === testID) return root;
  return find(root.props?.children, testID);
}

async function loadDialog(react: unknown = { useState: (initial: unknown) => [initial, () => {}] }) {
  return loadTs('components/relay/relay-passphrase-dialog.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    'react-native': { StyleSheet: { create: (styles: unknown) => styles }, View: 'View' },
    'react-native-paper': { Button: 'Button', HelperText: 'HelperText', Text: 'Text' },
    '@/components/ui/overlay-sheet': { OverlaySheet: 'OverlaySheet' },
    '@/components/ui/text-input': { TextInput: 'TextInput' },
    '@/constants/theme': { Colors: { light: {} } },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    '@/lib/relay/errors': { RelayE2EError, isRelayE2EError },
  });
}

const { mapRelayE2EErrorToDialogError } = await loadDialog();

describe('mapRelayE2EErrorToDialogError', () => {
  const cases: [string, unknown, DialogError][] = [
    ['wrong passphrase', new RelayE2EError('relay_e2e_bad_passphrase', 'bad'), 'badPassphrase'],
    ['unusable host key', new RelayE2EError('relay_e2e_key_unavailable', 'key'), 'keyFormat'],
    ['key rejected behind 404', new RelayE2EError('relay_e2e_key_unavailable', 'key', 404), 'keyFormat'],
    ['relay rejected the request', new RelayE2EError('relay_e2e_unauthorized', 'auth', 401), 'unauthorized'],
    ['relay unavailable', new RelayE2EError('relay_e2e_unavailable', 'offline'), 'network'],
    ['key request failed upstream', new RelayE2EError('relay_e2e_key_unavailable', 'upstream', 502), 'network'],
    ['unknown code falls back to status', new RelayE2EError('relay_e2e_stream_invalid', 'stream', 403), 'unauthorized'],
    ['unknown code without status is a network failure', new RelayE2EError('relay_e2e_decrypt_failed', 'decrypt'), 'network'],
    ['plain error with a server status', Object.assign(new Error('boom'), { status: 500 }), 'network'],
    ['plain error with an auth status', Object.assign(new Error('boom'), { status: 401 }), 'unauthorized'],
    ['non-error rejection', undefined, 'network'],
  ];

  it.each(cases)('%s', (_name, error, expected) => {
    expect(mapRelayE2EErrorToDialogError(error)).toBe(expected);
  });
});

async function mountDialog(reported: DialogError) {
  const runtime = hookRuntime();
  const { RelayPassphraseDialog } = await loadDialog(runtime.react);
  const onSubmit = vi.fn(async (_passphrase: string, reportError: (error: DialogError) => void) => {
    reportError(reported);
    return false;
  });
  runtime.mount(RelayPassphraseDialog, {
    hostName: 'Studio Mac',
    visible: true,
    onSubmit,
    onCancel: () => {},
  });
  const input = find(runtime.value, 'relay-passphrase-input');
  if (!input) throw new Error('Missing relay-passphrase-input');
  input.props.onChangeText('correct horse');
  runtime.flush();
  const submit = find(runtime.value, 'relay-passphrase-submit');
  if (!submit) throw new Error('Missing relay-passphrase-submit');
  submit.props.onPress();
  await runtime.settle();
  const errorText = find(runtime.value, 'relay-passphrase-error');
  if (!errorText) throw new Error('Missing relay-passphrase-error');
  return { onSubmit, message: errorText.props.children };
}

describe('RelayPassphraseDialog error copy', () => {
  it.each<[DialogError, string]>([
    ['badPassphrase', 'relay:unlock.badPassphrase'],
    ['keyFormat', 'relay:unlock.keyFormat'],
    ['unauthorized', 'relay:unlock.unauthorized'],
    ['network', 'relay:unlock.network'],
    ['unavailable', 'relay:unlock.network'],
  ])('renders the %s message', async (reported, expectedKey) => {
    const { onSubmit, message } = await mountDialog(reported);
    expect(onSubmit).toHaveBeenCalledWith('correct horse', expect.any(Function));
    expect(message).toBe(expectedKey);
  });
});
