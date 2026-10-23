import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Appbar, HelperText, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RelayHostList } from '@/components/relay/relay-host-list';
import { RelayPassphraseDialog, type RelayPassphraseError } from '@/components/relay/relay-passphrase-dialog';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { logout } from '@/lib/relay/auth';
import { isRelayE2EError } from '@/lib/relay/errors';
import { fetchRelayHosts } from '@/lib/relay/hosts';
import { clearHostKeys, fetchHostKey, getHostKey, unlockHostKey } from '@/lib/relay/keywrap';
import { isRelayReauthRequired } from '@/lib/relay/refresh';
import { clearPassphrase } from '@/lib/relay/session-key';
import type { RelayHost } from '@/lib/relay/types';
import { buildRelayServerUrl } from '@/lib/relay/url';
import { useConnection, useOnboarding } from '@/providers/opencode-contexts';

// Host picker after a relay sign-in. Choosing a host unlocks its E2E key when
// the tunnel has one, writes the full `/relay/{hostId}` serverUrl, records
// hostId/hostName, reconnects, and the root guard then lets the app fall
// through to the tabs.
export default function RelayHostsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const palette = Colors[useColorScheme() ?? 'light'];
  const insets = useSafeAreaInsets();
  const { settings, updateSettings, switchConnection } = useConnection();
  const { onboardingCompleted, onboardingActive } = useOnboarding();
  const relay = settings.relay;
  const [hosts, setHosts] = useState<RelayHost[]>([]);
  const [refreshing, setRefreshing] = useState(true);
  const [selecting, setSelecting] = useState<string>();
  const [unlockTarget, setUnlockTarget] = useState<RelayHost>();
  const [error, setError] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  // Navigation after a host pick is deferred to an effect: unmounting the
  // passphrase modal and replacing the route in the same frame trips a Fabric
  // mount error on some Android builds (addViewAt index mismatch).
  const [pendingNavigation, setPendingNavigation] = useState(false);
  const navigationTarget = useRef<string | undefined>(undefined);

  // A session that cannot be refreshed at all (no password in memory, or the
  // Relay keeps rejecting the fresh token) is unrecoverable in place: drop the
  // login and the in-memory key material, and let the login screen start over.
  const signOutToLogin = useCallback(async () => {
    clearPassphrase();
    clearHostKeys();
    await logout().catch(() => undefined);
    updateSettings({ relay: undefined });
    router.replace('/relay-login');
  }, [router, updateSettings]);

  const refresh = useCallback(async () => {
    if (!relay) return;
    setRefreshing(true);
    setError(false);
    setSelectionError(false);
    try {
      setHosts(await fetchRelayHosts(relay.relayUrl, relay.account));
    } catch (reason) {
      if (isRelayReauthRequired(reason)) {
        await signOutToLogin();
        return;
      }
      setError(true);
    } finally {
      setRefreshing(false);
    }
  }, [relay, signOutToLogin]);

  // Initial load. The state writes live in promise callbacks so the effect
  // body itself stays free of synchronous setState.
  useEffect(() => {
    let cancelled = false;
    if (!relay) return;
    fetchRelayHosts(relay.relayUrl, relay.account)
      .then((list) => { if (!cancelled) { setHosts(list); setError(false); } })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (isRelayReauthRequired(reason)) {
          void signOutToLogin();
          return;
        }
        setError(true);
      })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, [relay, signOutToLogin]);

  async function proceed(host: RelayHost) {
    if (!relay) return;
    try {
      // One settings write: a second updateSettings right after connecting
      // remounts the workspace runtime and suspends the connection we just
      // established (the project screen then reads "Disconnected").
      await switchConnection({
        serverUrl: buildRelayServerUrl(relay.relayUrl, host.id),
        username: '',
        password: '',
        connect: undefined,
        relay: { ...relay, hostId: host.id, hostName: host.name },
      });
      navigationTarget.current = !onboardingCompleted || onboardingActive ? '/onboarding/ai' : '/(tabs)/projects';
      setPendingNavigation(true);
    } catch {
      setSelectionError(true);
      setSelecting(undefined);
    }
  }

  // Runs after the settings update has been committed and the dialog has
  // unmounted, so the navigator never swaps screens mid-modal.
  useEffect(() => {
    if (!pendingNavigation) return;
    const target = navigationTarget.current;
    if (!target) return;
    // No timer and no state reset here: resetting `pendingNavigation` would
    // re-run this effect and cancel the navigation in the cleanup.
    router.replace(target);
  }, [pendingNavigation, router]);

  async function selectHost(host: RelayHost) {
    if (!relay || selecting) return;
    setSelecting(host.id);
    setSelectionError(false);
    try {
      // Switching to a different host drops the previous session's key
      // material before the new host is unlocked.
      if (relay.hostId && relay.hostId !== host.id) {
        clearPassphrase();
        clearHostKeys();
      }
      const material = await fetchHostKey(relay.relayUrl, host.id, undefined, relay.account);
      // The session cache means a reconnect (or re-picking the same unlocked
      // host) never re-prompts for the passphrase.
      if (material.wrapped && !getHostKey(host.id)) {
        // E2E host: the passphrase dialog continues the flow. `selecting`
        // stays set so the list remains inert behind the dialog.
        setUnlockTarget(host);
        return;
      }
      await proceed(host);
    } catch (reason) {
      // Only an unrecoverable session signs out. A key request rejected with a
      // freshly refreshed token keeps the session and lets the user retry.
      if (isRelayReauthRequired(reason)) {
        await signOutToLogin();
        return;
      }
      setSelectionError(true);
      setSelecting(undefined);
    }
  }

  async function handleUnlock(passphrase: string, reportError: (error: RelayPassphraseError) => void): Promise<boolean> {
    const host = unlockTarget;
    if (!host || !relay) return false;
    try {
      await unlockHostKey({ relayUrl: relay.relayUrl, hostId: host.id, passphrase, account: relay.account });
    } catch (reason) {
      if (isRelayReauthRequired(reason)) {
        await signOutToLogin();
        return true;
      }
      if (isRelayE2EError(reason, 'relay_e2e_bad_passphrase')) {
        reportError('badPassphrase');
        return false;
      }
      reportError('unavailable');
      return false;
    }
    setUnlockTarget(undefined);
    await proceed(host);
    return true;
  }

  function cancelUnlock() {
    setUnlockTarget(undefined);
    setSelecting(undefined);
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]} testID="relay-hosts-screen">
      <Appbar.Header statusBarHeight={0} style={{ backgroundColor: palette.surface, paddingTop: insets.top, height: 64 + insets.top }}>
        <Appbar.Content titleStyle={{ color: palette.text }} title={t('relay:hosts.title')} />
      </Appbar.Header>
      <View style={styles.body}>
        <Text variant="bodyMedium" style={{ color: palette.muted }}>{t('relay:hosts.subtitle')}</Text>
        {error ? (
          <HelperText testID="relay-hosts-error" type="error" visible>{t('relay:hosts.loadError')}</HelperText>
        ) : null}
        {selectionError ? (
          <HelperText testID="relay-host-select-error" type="error" visible>{t('relay:hosts.selectError')}</HelperText>
        ) : null}
        <View style={styles.listWrap} pointerEvents={selecting ? 'none' : 'auto'}>
          <RelayHostList hosts={hosts} refreshing={refreshing} onRefresh={() => void refresh()} onSelect={(host) => void selectHost(host)} />
        </View>
      </View>
      <RelayPassphraseDialog
        hostName={unlockTarget?.name ?? ''}
        visible={Boolean(unlockTarget)}
        onSubmit={handleUnlock}
        onCancel={cancelUnlock}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, gap: 16, padding: 20 },
  listWrap: { flex: 1 },
});
