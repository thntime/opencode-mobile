import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Button, HelperText, List } from 'react-native-paper';

import { TextInput } from '@/components/ui/text-input';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { RelayLoginError, login } from '@/lib/relay/auth';

export type RelayLoginValues = {
  relayUrl: string;
  account: string;
  tokenExpiresAt?: number;
};

// Presentation + local form state only. The caller (app/relay-login.tsx) owns
// navigation and writing the settings back, so this form stays reusable from
// onboarding and settings.
export function RelayLoginForm({
  initialRelayUrl = 'https://',
  onSubmit,
  onScan,
  onManual,
  onBusyChange,
}: {
  initialRelayUrl?: string;
  onSubmit: (values: RelayLoginValues) => Promise<void> | void;
  onScan: () => void;
  onManual: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<RelayLoginError['code']>();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function setBusy(next: boolean) {
    setBusyState(next);
    onBusyChange?.(next);
  }

  async function submit() {
    if (busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const result = await login(relayUrl, account, password);
      await onSubmit({ relayUrl: relayUrl.trim(), account: account.trim(), tokenExpiresAt: result.tokenExpiresAt });
    } catch (reason) {
      setError(reason instanceof RelayLoginError ? reason.code : 'unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.form} testID="relay-login-form">
      <TextInput
        testID="relay-login-url"
        label={t('relay:login.relayUrl')}
        placeholder={t('relay:login.relayUrlPlaceholder')}
        value={relayUrl}
        onChangeText={setRelayUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        disabled={busy}
      />
      <TextInput
        testID="relay-login-account"
        label={t('relay:login.account')}
        value={account}
        onChangeText={setAccount}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        disabled={busy}
      />
      <TextInput
        testID="relay-login-password"
        label={t('relay:login.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        disabled={busy}
      />
      {error ? (
        <HelperText testID="relay-login-error" type="error" visible>
          {t(`relay:login.errors.${error === 'invalid_request' ? 'invalidRequest'
            : error === 'invalid_credentials' ? 'invalidCredentials'
            : error === 'invalid_response' ? 'invalidResponse'
            : error}`)}
        </HelperText>
      ) : null}
      <Button
        testID="relay-login-submit"
        mode="contained"
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}>
        {t('relay:login.submit')}
      </Button>
      <View style={styles.advanced}>
        <Button
          testID="relay-login-advanced-toggle"
          mode="text"
          icon={advancedOpen ? 'chevron-up' : 'chevron-down'}
          contentStyle={{ flexDirection: 'row-reverse' }}
          style={{ alignSelf: 'flex-start' }}
          onPress={() => setAdvancedOpen((open) => !open)}>
          {t('relay:login.advanced')}
        </Button>
        {advancedOpen ? (
          <View style={styles.advancedBody}>
            <List.Item
              accessibilityRole="button"
              testID="relay-login-scan"
              title={t('relay:login.scan')}
              left={(props) => <List.Icon {...props} icon="qrcode-scan" color={palette.tint} />}
              right={(props) => <List.Icon {...props} icon="chevron-right" color={palette.muted} />}
              onPress={onScan}
              disabled={busy}
            />
            <List.Item
              accessibilityRole="button"
              testID="relay-login-manual"
              title={t('relay:login.manual')}
              left={(props) => <List.Icon {...props} icon="server" color={palette.tint} />}
              right={(props) => <List.Icon {...props} icon="chevron-right" color={palette.muted} />}
              onPress={onManual}
              disabled={busy}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  advanced: { gap: 4 },
  advancedBody: { gap: 4 },
});
