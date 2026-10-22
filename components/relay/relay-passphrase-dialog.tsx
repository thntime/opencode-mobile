import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';

import { OverlaySheet } from '@/components/ui/overlay-sheet';
import { TextInput } from '@/components/ui/text-input';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type RelayPassphraseError = 'badPassphrase' | 'unavailable';

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
        />
        {error ? (
          <HelperText testID="relay-passphrase-error" type="error" visible>{t(`relay:unlock.${error}`)}</HelperText>
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
