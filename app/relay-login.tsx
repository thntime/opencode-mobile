import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RelayLoginForm, type RelayLoginValues } from '@/components/relay/relay-login-form';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { normalizeRelayUrl } from '@/lib/relay/url';
import { useConnection, useOnboarding } from '@/providers/opencode-contexts';

// Standalone relay sign-in. On success the settings carry the `relay` block
// without a hostId yet, so the root guard lands the user on relay-hosts next.
export default function RelayLoginScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const palette = Colors[useColorScheme() ?? 'light'];
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useConnection();
  const { onboardingCompleted, onboardingActive } = useOnboarding();
  const [busy, setBusy] = useState(false);

  async function handleSubmit(values: RelayLoginValues) {
    updateSettings({
      relay: { relayUrl: normalizeRelayUrl(values.relayUrl), account: values.account, tokenExpiresAt: values.tokenExpiresAt },
    });
    router.replace('/relay-hosts');
  }

  // The scan/manual flows live on the chooser the user came from (onboarding
  // connect step or the settings add-connection sheet), so "advanced options"
  // simply returns there.
  const inOnboarding = !onboardingCompleted || onboardingActive;
  const backTarget = inOnboarding ? '/onboarding/connect' : '/(tabs)/settings';
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(backTarget);
  };

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]} testID="relay-login-screen">
      <Appbar.Header statusBarHeight={0} style={{ backgroundColor: palette.surface, paddingTop: insets.top, height: 64 + insets.top }}>
        <Appbar.BackAction color={palette.text} disabled={busy} accessibilityLabel={t('common:actions.back')} onPress={goBack} />
        <Appbar.Content titleStyle={{ color: palette.text }} title={t('relay:login.title')} />
      </Appbar.Header>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
          <Text variant="bodyMedium" style={{ color: palette.muted }}>{t('relay:login.subtitle')}</Text>
          <RelayLoginForm
            initialRelayUrl={settings.relay?.relayUrl ?? 'https://'}
            onBusyChange={setBusy}
            onSubmit={handleSubmit}
            onScan={goBack}
            onManual={goBack}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  body: { gap: 16, padding: 20 },
});
