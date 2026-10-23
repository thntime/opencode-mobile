import Constants from 'expo-constants';
import { DarkTheme, DefaultTheme, Redirect, Stack, ThemeProvider, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { getPaperTheme } from '@/constants/paper-theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useNotificationRoute } from '@/hooks/use-notification-route';
import { useQuickActionRoute } from '@/hooks/use-quick-action-route';
import { installGlobalErrorHandler } from '@/lib/error-reporting';
import '@/lib/i18n';
import { isConnectEnabled } from '@/lib/connect';
import { getRelayToken } from '@/lib/relay/auth';
import { relayRouteTarget, relayLoginRequired, subscribeRelayLoginRequired } from '@/lib/relay/guard';
import { isHostUnlocked } from '@/lib/relay/host-key-cache';
import type { RelayAuth } from '@/lib/relay/types';
import { useConnection, useOnboarding, useUpdates } from '@/providers/opencode-contexts';
import { UpdateNotice } from '@/components/ui/update-notice';
import { OpencodeProvider } from '@/providers/opencode-provider';

export const unstable_settings = {
  anchor: '(tabs)',
};

export { ErrorBoundary } from 'expo-router';

// Keep the native splash up until AsyncStorage/SecureStore hydration and the
// onboarding decision are known, so neither the assistant nor the app flashes.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const paperTheme = getPaperTheme(colorScheme === 'dark' ? 'dark' : 'light');
  const isE2EMode = Boolean(Constants.expoConfig?.extra?.e2eMode);

  useEffect(() => {
    if (Platform.OS === 'web' || isE2EMode) {
      return;
    }

    installGlobalErrorHandler();

    void import('@/lib/notifications')
      .then(({ initializeNotifications }) => initializeNotifications())
      .catch(() => undefined);

    void import('@/lib/voice/speech-output')
      .then(({ initializeVoiceAudioAsync }) => initializeVoiceAudioAsync())
      .catch(() => undefined);
  }, [isE2EMode]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <OpencodeProvider>
          <PaperProvider theme={paperTheme}>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <RootNavigator />
              <UpdateHost />
              <StatusBar style="auto" />
            </ThemeProvider>
          </PaperProvider>
        </OpencodeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function UpdateHost() {
  const pathname = usePathname();
  const updates = useUpdates();
  const { setSurfaceActive } = updates;
  const eligible = ['/', '/projects', '/settings', '/terminal'].includes(pathname);
  useLayoutEffect(() => {
    setSurfaceActive(eligible);
    return () => setSurfaceActive(false);
  }, [eligible, setSurfaceActive]);
  return <UpdateNotice {...updates} onDismissError={updates.clearError} />;
}

// The onboarding decision depends on persisted state, so routing waits for
// hydration. `Stack.Protected` swaps the assistant in and out without mounting
// the tab navigator behind it, which prevents any onboarding/app flash.
function RootNavigator() {
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme ?? 'light'];
  const pathname = usePathname();
  const { isHydrated, onboardingCompleted, onboardingActive } = useOnboarding();
  const { settings } = useConnection();
  useNotificationRoute();
  useQuickActionRoute(isHydrated);

  // Relay routing guard. The token lives in SecureStore, so its presence is
  // resolved asynchronously once a `relay` block exists; `undefined` keeps the
  // guard undecided instead of flashing the login route on cold starts.
  const relay = settings.relay;
  const [tokenCheck, setTokenCheck] = useState<{ relay: RelayAuth; hasToken: boolean }>();
  // Render-phase reset (React docs pattern) keeps the check tied to the relay
  // block it belongs to without a setState-in-effect.
  if (tokenCheck && tokenCheck.relay !== relay) setTokenCheck(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!relay) return;
    const current = relay;
    void getRelayToken()
      .then((token) => { if (!cancelled) setTokenCheck({ relay: current, hasToken: Boolean(token) }); })
      .catch(() => { if (!cancelled) setTokenCheck({ relay: current, hasToken: false }); });
    return () => { cancelled = true; };
  }, [relay]);
  const hasRelayToken = relay && tokenCheck?.relay === relay ? tokenCheck.hasToken : undefined;
  // D3: the refresh module keeps the session when it only lost the in-memory
  // password, so the guard needs its own signal to route back to /relay-login
  // (the persisted relayUrl/account stay in settings for form pre-fill).
  const relayNeedsLogin = useSyncExternalStore(subscribeRelayLoginRequired, relayLoginRequired, relayLoginRequired);

  useEffect(() => {
    if (isHydrated) {
      void SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [isHydrated]);

  if (!isHydrated) {
    return (
      <View style={[styles.hydration, { backgroundColor: palette.background }]}>
        <ActivityIndicator size="large" color={palette.tint} />
      </View>
    );
  }

  const onboardingVisible = !onboardingCompleted || onboardingActive;
  // Direct connections have no `relay` block and are never redirected; during
  // onboarding the connect step drives relay navigation explicitly.
  const relayTarget = onboardingCompleted && relay && hasRelayToken !== undefined
    ? relayRouteTarget(relay, hasRelayToken, relay.hostId ? isHostUnlocked(relay.hostId) : false, relayNeedsLogin)
    : undefined;

  return (
    <>
      {relayTarget && pathname !== relayTarget ? <Redirect href={relayTarget} /> : null}
      <Stack>
        <Stack.Protected guard={onboardingCompleted}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={onboardingVisible}>
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={isConnectEnabled()}>
          <Stack.Screen name="pair" options={{ headerShown: false }} />
          <Stack.Screen name="service" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Screen name="relay-login" options={{ headerShown: false }} />
        <Stack.Screen name="relay-hosts" options={{ headerShown: false }} />
        <Stack.Screen name="share" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hydration: { alignItems: 'center', flex: 1, justifyContent: 'center' },
});
