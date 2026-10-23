import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';

import { OverlaySheet } from '@/components/ui/overlay-sheet';
import { TextInput } from '@/components/ui/text-input';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { isRelayE2EError, type RelayE2EErrorCode } from '@/lib/relay/errors';

// `unavailable` is the pre-classification name for a transport failure. Callers
// may still report it; the dialog renders it as `network`.
export type RelayPassphraseError = 'badPassphrase' | 'keyFormat' | 'network' | 'unauthorized' | 'unavailable';

const CODE_TO_DIALOG_ERROR: Partial<Record<RelayE2EErrorCode, RelayPassphraseError>> = {
  relay_e2e_bad_passphrase: 'badPassphrase',
  relay_e2e_key_unavailable: 'keyFormat',
  relay_e2e_unauthorized: 'unauthorized',
  relay_e2e_unavailable: 'network',
};

function errorStatus(error: unknown): number | undefined {
  if (isRelayE2EError(error)) return error.status;
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

// Turns a Relay E2E failure into the four reasons the dialog can explain. The
// code is authoritative, but a 5xx/throttled status means the Relay itself was
// unreachable even when the key layer folded it into `key_unavailable`.
export function mapRelayE2EErrorToDialogError(error: unknown): RelayPassphraseError {
  const status = errorStatus(error);
  if (status !== undefined && (status >= 500 || status === 408 || status === 429)) {
    return 'network';
  }
  if (isRelayE2EError(error)) {
    const mapped = CODE_TO_DIALOG_ERROR[error.code];
    if (mapped) return mapped;
  }
  if (status === 401 || status === 403) return 'unauthorized';
  return 'network';
}

function dialogErrorKey(error: RelayPassphraseError): Exclude<RelayPassphraseError, 'unavailable'> {
  return error === 'unavailable' ? 'network' : error;
}

// One-shot E2E passphrase prompt shown between host selection and navigation.
// A wrong passphrase keeps the dialog open (never falls back to plaintext);
// cancel returns to the host list.
export function RelayPassphraseDialog({
  hostName,
  visible,
  onSubmit,
  onCancel,
}: {
  hostName: string;
  visible: boolean;
  /** Resolves when the unlock succeeded; rejects stay inside the dialog. */
  onSubmit: (passphrase: string, reportError: (error: RelayPassphraseError) => void) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RelayPassphraseError>();

  // Reset the form when the dialog opens for a (new) host — render-phase
  // reset per React docs, keyed on the visible host.
  const [formHost, setFormHost] = useState<string>();
  const openHost = visible ? hostName : undefined;
  if (formHost !== openHost) {
    setFormHost(openHost);
    setPassphrase('');
    setError(undefined);
  }

  async function submit() {
    if (busy || !passphrase) return;
    setBusy(true);
    setError(undefined);
    try {
      const unlocked = await onSubmit(passphrase, setError);
      if (!unlocked) return; // Error already reported; stay in the dialog.
    } finally {
      setBusy(false);
    }
  }

  return (
    <OverlaySheet visible={visible} title={t('relay:unlock.title', { name: hostName })} onClose={onCancel} fitContent dismissible={!busy} testID="relay-passphrase-dialog">
      <View style={styles.body}>
        <Text variant="bodyMedium" style={{ color: palette.muted }}>{t('relay:unlock.body')}</Text>
        <TextInput
          testID="relay-passphrase-input"
          label={t('relay:unlock.passphrase')}
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          disabled={busy}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        {error ? (
          <HelperText testID="relay-passphrase-error" type="error" visible>{t(`relay:unlock.${dialogErrorKey(error)}`)}</HelperText>
        ) : null}
        <View style={styles.actions}>
          <Button
            testID="relay-passphrase-submit"
            mode="contained"
            loading={busy}
            disabled={busy || !passphrase}
            onPress={() => void submit()}>
            {t('relay:unlock.submit')}
          </Button>
          <Button testID="relay-passphrase-cancel" mode="text" disabled={busy} onPress={onCancel}>
            {t('common:actions.cancel')}
          </Button>
        </View>
      </View>
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
