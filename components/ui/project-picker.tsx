import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text as NativeText, View } from 'react-native';
import { Button, Checkbox, Text } from 'react-native-paper';

import { WorktreePicker } from '@/components/project/worktree-picker';
import { WorkspaceSelect } from '@/components/ui/workspace-select';
import { useWorkspaces } from '@/providers/workspace-context';
import { useWorkspaceProjects } from '@/providers/use-workspace-projects';
import { ProjectOptions } from '@/components/onboarding/project-options';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { buildClient } from '@/lib/opencode/client';
import { scanForProjects, type ScanCandidate } from '@/lib/project-discovery';
import {
  buildScanListDirectory,
  normalizeScanPath,
  resolveScanRoot,
} from '@/providers/services/project-discovery-service';
import type { WorkspaceTarget } from '@/providers/workspace-types';
import { OverlaySheet } from './overlay-sheet';
import { TextInput } from './text-input';

export function ProjectPickerButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];
  return <Pressable accessibilityRole="button" accessibilityLabel={t('project:picker.changeProject')} onPress={onPress} style={styles.button}>
    <MaterialCommunityIcons name="folder-swap-outline" size={20} color={palette.tint} />
    <NativeText style={{ color: palette.tint }}>{t('common:tabs.projects')}</NativeText>
  </Pressable>;
}

/** Parent of a remote POSIX path; empty for a path that has no parent. */
function parentDirectory(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : trimmed.slice(0, index);
}

export function ProjectPicker({ visible, onClose, activePath, onSelected, testID }: {
  visible: boolean;
  onClose: () => void;
  activePath?: string;
  onSelected?: () => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];
  const registry = useWorkspaces();
  const { groups, add, remove } = useWorkspaceProjects();
  const multipleServers = registry.connections.length > 1;
  const [server, setServer] = useState('');
  const [query, setQuery] = useState('');
  const [addServer, setAddServer] = useState(registry.focus?.connectionId ?? '');
  const [adding, setAdding] = useState(false);
  const [directory, setDirectory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Discovery is a sub-state of the add form so the sheet keeps one structure.
  const [discovering, setDiscovering] = useState(false);
  const [scanRoot, setScanRoot] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [scanError, setScanError] = useState<string>();
  const [addError, setAddError] = useState<string>();
  const [addingSelected, setAddingSelected] = useState(false);
  const scanSignal = useRef<{ cancelled: boolean } | undefined>(undefined);
  // Progress mirror: the scanner reports results only when it settles, so the
  // live counter and the cancelled view are fed from each listing instead.
  const scanFound = useRef<string[]>([]);
  const scanExisting = useRef<Set<string>>(new Set());

  const connectionId = multipleServers ? addServer : groups[0]?.id ?? '';
  const activeProjectFor = (id: string) => {
    if (!id) return '';
    const focus = registry.focus;
    if (focus?.connectionId === id && focus.projectPath) return focus.projectPath;
    if (!multipleServers && activePath) return activePath;
    const snapshot = Object.entries(registry.snapshots).find(([key]) => (JSON.parse(key) as string[])[0] === id)?.[1];
    return snapshot?.values.projectsValue.activeProjectPath
      || registry.connections.find((entry) => entry.id === id)?.settings.directory
      || '';
  };
  const contractFor = (id: string) => Object.entries(registry.snapshots)
    .find(([key]) => (JSON.parse(key) as string[])[0] === id)?.[1].values.connectionValue.serverCapabilities.contract ?? 'v2';
  const projectsFor = (id: string) => groups.find((group) => group.id === id)?.projects.map((project) => project.path) ?? [];

  const resetDiscover = () => {
    setScanRoot('');
    setScanning(false);
    setScanned(false);
    setScanCount(0);
    setCandidates([]);
    setSelectedPaths([]);
    setTruncated(false);
    setSkipped(0);
    setScanError(undefined);
    setAddError(undefined);
    setAddingSelected(false);
    scanSignal.current = undefined;
    scanFound.current = [];
    scanExisting.current = new Set();
  };
  // D6: a closed or unmounted picker must not keep dispatching directory reads.
  useEffect(() => () => { if (scanSignal.current) scanSignal.current.cancelled = true; }, []);

  const close = () => {
    if (scanSignal.current) scanSignal.current.cancelled = true;
    setAdding(false);
    setDiscovering(false);
    setDirectory('');
    setError(undefined);
    resetDiscover();
    onClose();
  };
  const activate = async (target: WorkspaceTarget) => {
    await registry.activate(target);
    onSelected?.();
    close();
  };
  const openDiscover = () => {
    resetDiscover();
    setScanRoot(parentDirectory(activeProjectFor(connectionId)));
    setDiscovering(true);
  };
  const backToAdd = () => {
    if (scanSignal.current) scanSignal.current.cancelled = true;
    resetDiscover();
    setDiscovering(false);
  };
  const cancelScan = () => {
    const signal = scanSignal.current;
    if (!signal) return;
    signal.cancelled = true;
    // Keep what was already discovered visible instead of flashing an empty list.
    const found = scanFound.current;
    setCandidates(found.map((path) => ({ path, exists: scanExisting.current.has(path) })));
    setSelectedPaths(found.filter((path) => !scanExisting.current.has(path)));
    setScanned(true);
    setScanning(false);
  };
  const startScan = () => {
    const root = scanRoot.trim();
    if (!root || scanning) return;
    const id = connectionId;
    const entry = registry.connections.find((item) => item.id === id);
    if (!entry) {
      setScanError(t('project:errors.addProject'));
      return;
    }
    const signal = { cancelled: false };
    const existingPaths = projectsFor(id);
    scanSignal.current = signal;
    scanFound.current = [];
    scanExisting.current = new Set(existingPaths.map(normalizeScanPath));
    setScanning(true);
    setScanned(false);
    setScanCount(0);
    setCandidates([]);
    setSelectedPaths([]);
    setTruncated(false);
    setSkipped(0);
    setScanError(undefined);
    setAddError(undefined);
    void (async () => {
      try {
        const client = buildClient({ ...entry.settings, directory: activeProjectFor(id) || root }, contractFor(id));
        const listDirectory = buildScanListDirectory(client);
        const result = await scanForProjects({
          root: resolveScanRoot(client, root),
          existingPaths,
          signal,
          listDirectory: async (path) => {
            const entries = await listDirectory(path);
            if (!signal.cancelled && entries.some((item) => item.type === 'directory' && item.name === '.opencode')) {
              scanFound.current.push(path);
              setScanCount(scanFound.current.length);
            }
            return entries;
          },
        });
        // A cancelled scan was already rendered from the progress mirror.
        if (!signal.cancelled) {
          setCandidates(result.candidates);
          setSelectedPaths(result.candidates.filter((candidate) => !candidate.exists).map((candidate) => candidate.path));
          setTruncated(result.truncated);
          setSkipped(result.skippedForPermission);
          setScanned(true);
        }
      } catch (reason) {
        if (!signal.cancelled) setScanError(reason instanceof Error ? reason.message : t('project:errors.addProject'));
      } finally {
        if (scanSignal.current === signal) {
          scanSignal.current = undefined;
          setScanning(false);
        }
      }
    })();
  };
  const toggleCandidate = (path: string) => {
    const candidate = candidates.find((item) => item.path === path);
    if (!candidate || candidate.exists) return;
    setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  };
  const addSelected = () => {
    if (addingSelected) return;
    const id = connectionId;
    const paths = candidates
      .filter((candidate) => !candidate.exists && selectedPaths.includes(candidate.path))
      .map((candidate) => candidate.path);
    if (!paths.length) return;
    setAddingSelected(true);
    setAddError(undefined);
    void (async () => {
      const addedTargets: WorkspaceTarget[] = [];
      const addedPaths: string[] = [];
      let failure: string | undefined;
      // Serial writes keep the workspace registry consistent and let a partial
      // failure keep the projects that already succeeded.
      for (const path of paths) {
        try {
          addedTargets.push(await add(id, path));
          addedPaths.push(path);
        } catch (reason) {
          failure ??= reason instanceof Error ? reason.message : String(reason);
        }
      }
      setAddingSelected(false);
      if (addedPaths.length) {
        const done = new Set(addedPaths);
        setCandidates((current) => current.map((candidate) => done.has(candidate.path) ? { ...candidate, exists: true } : candidate));
        setSelectedPaths((current) => current.filter((path) => !done.has(path)));
      }
      if (failure) {
        setAddError(t('project:discoverFailed', { message: failure }));
        return;
      }
      if (addedTargets.length === 1) {
        await activate(addedTargets[0]).catch((reason) => setAddError(reason instanceof Error ? reason.message : String(reason)));
        return;
      }
      // Several projects: return to the list and let the user pick which one to open.
      if (addedTargets.length > 1) {
        setAdding(false);
        setDiscovering(false);
        resetDiscover();
        const snapshot = Object.entries(registry.snapshots).find(([key]) => (JSON.parse(key) as string[])[0] === id)?.[1];
        if (snapshot) void snapshot.values.projectsValue.refreshProjectCatalog(true).catch(() => undefined);
      }
    })();
  };

  return <OverlaySheet visible={visible} title={t('project:picker.title')} testID={testID} onClose={close}>
    {adding ? (discovering ? <View style={styles.addForm}>
      <Text style={{ color: palette.muted }}>{t('project:picker.enterPath')}</Text>
      {multipleServers ? <WorkspaceSelect title={t('common:servers.server')} value={addServer} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={setAddServer} /> : null}
      <TextInput testID="project-discover-root" mode="outlined" label={t('project:discoverRoot')} value={scanRoot} onChangeText={setScanRoot} autoCapitalize="none" autoCorrect={false} autoFocus={!scanRoot} />
      {scanError ? <Text testID="project-discover-scan-error" style={{ color: palette.danger }}>{scanError}</Text> : null}
      {scanning ? <>
        <Text testID="project-discover-progress">{t('project:discoverScanning', { count: scanCount })}</Text>
        <Button testID="project-discover-cancel" onPress={cancelScan}>{t('project:discoverCancel')}</Button>
      </> : <>
        <Button testID="project-discover-start" mode="contained" disabled={!scanRoot.trim()} onPress={startScan}>{t('project:discoverStart')}</Button>
        {scanned ? <>
          {candidates.map((candidate, index) => {
            const selected = !candidate.exists && selectedPaths.includes(candidate.path);
            return <Pressable key={candidate.path} testID={`project-discover-item-${index}`} accessibilityRole="checkbox"
              accessibilityState={{ checked: selected, disabled: candidate.exists }} disabled={candidate.exists}
              onPress={() => toggleCandidate(candidate.path)} style={styles.resultRow}>
              <Checkbox status={selected ? 'checked' : 'unchecked'} disabled={candidate.exists} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: candidate.exists ? palette.muted : palette.text }}>{candidate.path}</Text>
                {candidate.exists ? <Text style={{ color: palette.muted }}>{t('project:discoverExisting')}</Text> : null}
              </View>
            </Pressable>;
          })}
          {candidates.every((candidate) => candidate.exists) ? <Text testID="project-discover-empty">{t('project:discoverEmpty')}</Text> : null}
          {truncated ? <Text testID="project-discover-truncated" style={{ color: palette.warning }}>{t('project:discoverTruncated')}</Text> : null}
          {skipped > 0 ? <Text testID="project-discover-skipped" style={{ color: palette.warning }}>{t('project:discoverSkipped', { count: skipped })}</Text> : null}
          {addError ? <Text testID="project-discover-error" style={{ color: palette.danger }}>{addError}</Text> : null}
          <View style={styles.formActions}>
            <Button onPress={backToAdd}>{t('common:actions.cancel')}</Button>
            <Button testID="project-discover-add" mode="contained" loading={addingSelected} disabled={addingSelected || selectedPaths.length === 0} onPress={addSelected}>{t('project:discoverAddSelected', { count: selectedPaths.length })}</Button>
          </View>
        </> : null}
      </>}
    </View> : <View style={styles.addForm}>
      <Text style={{ color: palette.muted }}>{t('project:picker.enterPath')}</Text>
      {multipleServers ? <WorkspaceSelect title={t('common:servers.server')} value={addServer} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={setAddServer} /> : null}
      <TextInput testID="project-add-path" mode="outlined" label={t('project:picker.serverDirectory')} value={directory} onChangeText={setDirectory} autoCapitalize="none" autoCorrect={false} />
      <Button testID="project-discover-open" icon="folder-search-outline" onPress={openDiscover}>{t('project:discover')}</Button>
      {error ? <Text style={{ color: palette.danger }}>{error}</Text> : null}
      <View style={styles.formActions}>
        <Button disabled={saving} onPress={() => { setAdding(false); setError(undefined); }}>{t('common:actions.cancel')}</Button>
        <Button testID="project-add-submit" mode="contained" loading={saving} disabled={saving || !directory.trim()} onPress={() => {
          setSaving(true); setError(undefined);
          void add(connectionId, directory).then(activate).catch((reason) => setError(reason instanceof Error ? reason.message : t('project:errors.addProject'))).finally(() => setSaving(false));
        }}>{t('project:picker.add')}</Button>
      </View>
    </View>) : <>
    <TextInput testID="project-search" mode="outlined" label={t('common:servers.searchProjects')} placeholder={t('common:servers.searchProjects')} value={query} onChangeText={setQuery} />
    {multipleServers ? <WorkspaceSelect title={t('common:servers.allServers')} value={server} options={[{ value: '', label: t('common:servers.allServers') }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} onChange={setServer} /> : null}
    {groups.filter((group) => !multipleServers || !server || server === group.id).map((group) => <View key={group.id} style={{ gap: 10 }}>
      {multipleServers || group.status !== 'connected' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {multipleServers ? <Text variant="titleMedium" style={{ flex: 1 }}>{group.name}</Text> : null}
        <Text style={{ color: group.status === 'connected' ? palette.tint : palette.warning }}>{t(`common:servers.status.${group.status}`)}</Text>
        {group.status !== 'connected' ? <Button onPress={() => void registry.retry(group.id).catch((reason) => setError(String(reason)))}>{t('common:actions.reconnect')}</Button> : null}
      </View> : null}
      {group.status !== 'connected' ? <Text style={{ color: palette.muted }}>{t('common:servers.lastSynced')}</Text> : null}
      <ProjectOptions disabled={group.status !== 'connected'} projects={group.projects.filter((project) => `${project.label} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()))}
        activePath={registry.focus?.connectionId === group.id ? activePath : undefined}
        onSelect={(path) => { if (group.status !== 'connected') return; void activate({ connectionId: group.id, projectPath: path }).catch((reason) => setError(String(reason))); }}
        onRemove={(path) => { void remove({ connectionId: group.id, projectPath: path }).catch((reason) => setError(String(reason))); }} />
    </View>)}
    {error ? <Text style={{ color: palette.danger }}>{error}</Text> : null}
    {visible ? <WorktreePicker key={activePath} visible onSelect={(path) => { if (registry.focus) void activate({ connectionId: registry.focus.connectionId, projectPath: path }).catch((reason) => setError(String(reason))); }} /> : null}
    <Button testID="project-add-button" icon="plus" onPress={() => { setAddServer(server || registry.focus?.connectionId || groups[0]?.id || ''); setAdding(true); }}>{t('project:picker.add')}</Button>
    </>}
  </OverlaySheet>;
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 6 },
  addForm: { gap: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
});
