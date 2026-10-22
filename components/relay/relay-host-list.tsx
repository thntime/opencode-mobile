import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { formatRelativeTime } from '@/lib/opencode/format/time';
import type { RelayHost } from '@/lib/relay/types';

// Row visuals mirror components/settings/connection-profiles.tsx (bordered row,
// status pill on surfaceAlt) so the host list reads as the same list language.
export function RelayHostList({
  hosts,
  refreshing,
  onRefresh,
  onSelect,
}: {
  hosts: RelayHost[];
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (host: RelayHost) => void;
}) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];

  function lastSeenLabel(host: RelayHost) {
    if (!host.lastSeen) return t('relay:hosts.neverSeen');
    const parsed = Date.parse(host.lastSeen);
    if (!Number.isFinite(parsed)) return t('relay:hosts.neverSeen');
    return t('relay:hosts.lastSeen', { time: formatRelativeTime(parsed) });
  }

  return (
    <ScrollView
      testID="relay-host-list"
      style={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.tint} />}>
      {hosts.length === 0 ? (
        <View style={[styles.empty, { borderColor: palette.border, backgroundColor: palette.surface }]}>
          <Text variant="bodyMedium" style={{ color: palette.muted }} testID="relay-hosts-empty">
            {t('relay:hosts.empty')}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {hosts.map((host) => (
            <Pressable
              key={host.id}
              testID={`relay-host-${host.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${host.name}, ${host.online ? t('relay:hosts.online') : t('relay:hosts.offline')}, ${lastSeenLabel(host)}`}
              onPress={() => onSelect(host)}
              style={[styles.row, { borderColor: palette.border, backgroundColor: palette.background }]}>
              <View style={styles.rowCopy}>
                <Text numberOfLines={1} variant="titleSmall" style={{ color: palette.text }}>{host.name}</Text>
                <Text numberOfLines={1} variant="bodySmall" style={{ color: palette.muted }}>{lastSeenLabel(host)}</Text>
              </View>
              <View style={[styles.status, { backgroundColor: palette.surfaceAlt }]}>
                <Text variant="labelLarge" style={{ color: host.online ? palette.tint : palette.muted }}>
                  {host.online ? t('relay:hosts.online') : t('relay:hosts.offline')}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  list: { gap: 8 },
  empty: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  row: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowCopy: { flex: 1, gap: 2 },
  status: { borderRadius: 12, justifyContent: 'center', minHeight: 30, paddingHorizontal: 10 },
});
