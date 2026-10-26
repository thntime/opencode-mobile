import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text as NativeText, useWindowDimensions, View } from 'react-native';
import { Button, Checkbox, Text } from 'react-native-paper';

import { WorktreePicker } from '@/components/project/worktree-picker';
import { WorkspaceSelect } from '@/components/ui/workspace-select';
import { useWorkspaces } from '@/providers/workspace-context';
import { useProjectDiscovery } from '@/providers/use-project-discovery';
import { useWorkspaceProjects } from '@/providers/use-workspace-projects';
import { PROJECTS_MAX } from '@/providers/projects-storage';
import { ProjectOptions } from '@/components/onboarding/project-options';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { normalizeScanPath, type ScanCandidate } from '@/lib/project-discovery';
import type { WorkspaceTarget } from '@/providers/workspace-types';
import { OverlaySheet } from './overlay-sheet';
import { TextInput } from './text-input';

const MAX_BATCH_ADD = 10;

export function ProjectPickerButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const palette = Colors[useColorScheme() ?? 'light'];
  return <Pressable accessibilityRole="button" accessibilityLabel={t('project:picker.changeProject')} onPress={onPress} style={styles.button}>
    <MaterialCommunityIcons name="folder-swap-outline" size={20} color={palette.tint} />
    <NativeText style={{ color: palette.tint }}>{t('common:tabs.projects')}</NativeText>
  </Pressable>;
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
  const { height: windowHeight } = useWindowDimensions();
  const registry = useWorkspaces();
  const { groups, add, remove } = useWorkspaceProjects();
  const { scan, resolveDefaultRoot, isV1, refreshProjects } = useProjectDiscovery();
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
  const [cancelledScan, setCancelledScan] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [failedReads, setFailedReads] = useState(0);
  const [scanError, setScanError] = useState<string>();
  const [addErrors, setAddErrors] = useState<{ path: string; message: string }[]>([]);
  const [addingSelected, setAddingSelected] = useState(false);
  // The connection the visible results came from. Adding is blocked when the
  // user switches servers without rescanning, so stale paths cannot land on the
  // wrong host.
  const [scannedConnectionId, setScannedConnectionId] = useState<string>();
  const scanSignal = useRef<{ cancelled: boolean } | undefined>(undefined);
  const rootInputRef = useRef<{ blur: () => void } | null>(null);
  // Callback ref keeps the wrapper's intersection ref type out of the JSX.
  const setRootInputRef = useCallback((instance: { blur: () => void } | null) => {
    rootInputRef.current = instance;
  }, []);
  // Progress mirror: the scanner reports results only when it settles, so the
  // live counter and the cancelled view are fed from each listing instead.
  const scanFound = useRef<string[]>([]);
  const scanExisting = useRef<Set<string>>(new Set());
  // Latest values for async flows: the batch loop must not keep using the
  // connection or snapshots captured when it started.
  const connectionIdRef = useRef('');
  const refreshProjectsRef = useRef(refreshProjects);
  // A batch is identified by a token so a later batch (or a close) can
  // invalidate the loop before it touches the next path.
  const batchTokenRef = useRef(0);
  const batchRef = useRef<{ token: number; connectionId: string } | null>(null);
  const batchAbortRef = useRef(false);
  useEffect(() => { refreshProjectsRef.current = refreshProjects; }, [refreshProjects]);

  const connectionId = multipleServers ? addServer : groups[0]?.id ?? '';
  useEffect(() => { connectionIdRef.current = connectionId; }, [connectionId]);
  // `activePath` describes the focused server only; a different server must use
  // its own snapshot/settings instead.
  const fallbackPath = multipleServers ? undefined : activePath;
  const v1Connection = isV1(connectionId);
  const resultsStale = scanned && scannedConnectionId !== connectionId;
  // In the results state the sheet itself must not scroll: the warning rows and
  // the add action stay pinned while only the candidate list scrolls.
  const resultsVisible = adding && discovering && scanned && !scanning;

  const clearScanResults = () => {
    setScanned(false);
    setScanCount(0);
    setCandidates([]);
    setSelectedPaths([]);
    setTruncated(false);
    setCancelledScan(false);
    setSkipped(0);
    setFailedReads(0);
    setScanError(undefined);
    setAddErrors([]);
    // `addingSelected` belongs to the running batch: only its own `finally` may
    // clear it, otherwise a second batch could start concurrently.
    setScannedConnectionId(undefined);
    scanFound.current = [];
    scanExisting.current = new Set();
  };
  const cancelActiveScan = () => {
    if (scanSignal.current) scanSignal.current.cancelled = true;
    scanSignal.current = undefined;
  };
  const resetDiscover = () => {
    cancelActiveScan();
    setScanRoot('');
    setScanning(false);
    clearScanResults();
  };
  // D6: a closed or unmounted picker must not keep dispatching directory reads.
  useEffect(() => () => { if (scanSignal.current) scanSignal.current.cancelled = true; }, []);
  useEffect(() => {
    if (visible) return;
    // Closing the sheet without going through `close` still has to stop the
    // scan. The scanner polls cancellation, so its own `finally` clears the
    // scanning state without a synchronous setState here.
    if (scanSignal.current) scanSignal.current.cancelled = true;
  }, [visible]);

  const close = () => {
    cancelActiveScan();
    // A batch that is mid-flight must not keep adding to a closed picker.
    batchAbortRef.current = true;
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
    setScanRoot(resolveDefaultRoot(connectionId, fallbackPath));
    setDiscovering(true);
  };
  const backToAdd = () => {
    resetDiscover();
    setDiscovering(false);
  };
  // I2: switching servers invalidates everything the previous server produced.
  // While a batch is running the selection and root are frozen so paths cannot
  // land on a server the batch did not start on.
  const changeServer = (id: string) => {
    if (addingSelected) return;
    cancelActiveScan();
    setAddServer(id);
    resetDiscover();
    setScanRoot(resolveDefaultRoot(id, fallbackPath));
  };
  const changeRoot = (value: string) => {
    if (addingSelected) return;
    // Editing the root while results are visible invalidates them: the list no
    // longer describes what the input points at.
    if (scanning) {
      cancelActiveScan();
      setScanning(false);
    }
    if (scanned || scanError || candidates.length > 0) clearScanResults();
    setScanRoot(value);
  };
  const scanErrorMessage = (reason: unknown) => {
    const record = reason && typeof reason === 'object'
      ? reason as { code?: unknown; status?: unknown; errno?: unknown }
      : undefined;
    switch (record?.code) {
      case 'scan_scope_v1': return t('project:discoverV1Hint');
      case 'scan_unsupported': return t('project:discoverUnsupported');
      case 'scan_root_required':
      case 'scan_root_relative': return t('project:discoverRootInvalid');
      case 'scan_connection_missing': return t('project:errors.addProject');
      case 'scan_directory_unreadable':
        return record.status === 401 || record.status === 403 || record.errno === 'EACCES'
          ? t('project:discoverRootPermission')
          : t('project:discoverRootUnavailable');
      default: return t('project:discoverScanFailed');
    }
  };
  const cancelScan = () => {
    const signal = scanSignal.current;
    if (!signal) return;
    signal.cancelled = true;
    scanSignal.current = undefined;
    // Keep what was already discovered visible instead of flashing an empty
    // list, in the same path order a completed scan would produce.
    const found = [...scanFound.current].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    setCandidates(found.map((path) => ({ path, exists: scanExisting.current.has(path) })));
    // Nothing is preselected: a stray tap on the add button must not batch-add.
    setSelectedPaths([]);
    setScanned(true);
    setScannedConnectionId(connectionId);
    setTruncated(true);
    setCancelledScan(true);
    setScanning(false);
  };
  const startScan = () => {
    // The keyboard covers the lower half of the sheet, so hide it before the
    // results arrive; the root input is not focused again afterwards.
    Keyboard.dismiss();
    rootInputRef.current?.blur();
    const root = scanRoot.trim();
    if (!root || scanning || addingSelected) return;
    const id = connectionId;
    if (!registry.connections.some((item) => item.id === id)) {
      setScanError(t('project:errors.addProject'));
      return;
    }
    const signal = { cancelled: false };
    const existingPaths = groups.find((group) => group.id === id)?.projects.map((project) => project.path) ?? [];
    scanSignal.current = signal;
    scanFound.current = [];
    scanExisting.current = new Set(existingPaths.map(normalizeScanPath));
    setScanning(true);
    setScanned(false);
    setScanCount(0);
    setCandidates([]);
    setSelectedPaths([]);
    setTruncated(false);
    setCancelledScan(false);
    setSkipped(0);
    setFailedReads(0);
    setScanError(undefined);
    setAddErrors([]);
    setScannedConnectionId(id);
    void (async () => {
      try {
        const result = await scan(id, root, {
          signal,
          fallbackPath,
          onProgress: ({ found }) => {
            if (signal.cancelled) return;
            scanFound.current = found;
            setScanCount(found.length);
          },
        });
        // A cancelled scan was already rendered from the progress mirror.
        if (!signal.cancelled) {
          setCandidates(result.candidates);
          // Discovery only surfaces options; the user opts in explicitly.
          setSelectedPaths([]);
          setTruncated(result.truncated);
          setSkipped(result.skippedForPermission);
          setFailedReads(result.failedReads);
          setScanned(true);
          setScannedConnectionId(id);
        }
      } catch (reason) {
        if (!signal.cancelled) setScanError(scanErrorMessage(reason));
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
    // Never add results produced for a different server.
    if (scannedConnectionId !== connectionId) return;
    const id = connectionId;
    const paths = candidates
      .filter((candidate) => !candidate.exists && selectedPaths.includes(candidate.path))
      .map((candidate) => candidate.path);
    if (!paths.length) return;
    if (paths.length > MAX_BATCH_ADD) {
      setAddErrors([{ path: '', message: t('project:discoverAddLimit', { count: MAX_BATCH_ADD }) }]);
      return;
    }
    // The registry silently caps the list at PROJECTS_MAX; refuse the batch
    // instead of dropping paths without telling the user.
    const existingCount = groups.find((group) => group.id === id)?.projects.length ?? 0;
    if (existingCount + paths.length > PROJECTS_MAX) {
      setAddErrors([{
        path: '',
        message: t('project:discoverProjectLimit', { count: Math.max(0, PROJECTS_MAX - existingCount) }),
      }]);
      return;
    }
    const token = batchTokenRef.current + 1;
    batchTokenRef.current = token;
    batchRef.current = { token, connectionId: id };
    batchAbortRef.current = false;
    setAddingSelected(true);
    setAddErrors([]);
    void (async () => {
      const addedTargets: WorkspaceTarget[] = [];
      const addedPaths: string[] = [];
      const failures: { path: string; message: string }[] = [];
      let aborted = false;
      // The batch may only keep writing while it still belongs to the selected
      // connection and has not been closed.
      const isCurrent = () => !batchAbortRef.current
        && batchRef.current?.token === token
        && connectionIdRef.current === id;
      // Serial writes keep the workspace registry consistent and let a partial
      // failure keep the projects that already succeeded.
      try {
        for (const path of paths) {
          if (!isCurrent()) {
            aborted = true;
            break;
          }
          try {
            const target = await add(id, path);
            if (!isCurrent()) {
              aborted = true;
              break;
            }
            addedTargets.push(target);
            addedPaths.push(path);
          } catch (reason) {
            if (!isCurrent()) {
              aborted = true;
              break;
            }
            failures.push({ path, message: reason instanceof Error ? reason.message : String(reason) });
          }
        }
      } finally {
        // Only the batch that is still current may clear the flag; a newer batch
        // (or a closed picker) owns it otherwise.
        if (batchRef.current?.token === token) {
          batchRef.current = null;
          setAddingSelected(false);
        }
      }
      if (aborted || batchAbortRef.current) return;
      if (addedPaths.length) {
        const done = new Set(addedPaths);
        setCandidates((current) => current.map((candidate) => done.has(candidate.path) ? { ...candidate, exists: true } : candidate));
        setSelectedPaths((current) => current.filter((path) => !done.has(path)));
      }
      if (failures.length) {
        // Every failure keeps its own path and stays selected for a retry.
        setAddErrors(failures);
        return;
      }
      if (addedTargets.length === 1) {
        await activate(addedTargets[0]).catch((reason) => setAddErrors([{
          path: addedTargets[0].projectPath,
          message: reason instanceof Error ? reason.message : String(reason),
        }]));
        return;
      }
      // Several projects: return to the list and let the user pick which one to open.
      if (addedTargets.length > 1) {
        setAdding(false);
        setDiscovering(false);
        resetDiscover();
        await refreshProjectsRef.current(id);
      }
    })();
  };

  return <OverlaySheet visible={visible} title={t('project:picker.title')} testID={testID} onClose={close}
    scrollable={!resultsVisible}>
    {adding ? (discovering ? <View style={[styles.addForm, resultsVisible && styles.resultsForm]}>
      <Text style={{ color: palette.muted }}>{t('project:picker.enterPath')}</Text>
      {multipleServers ? <WorkspaceSelect testID="project-discover-server" title={t('common:servers.server')} value={addServer} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={changeServer} disabled={addingSelected} /> : null}
      <TextInput testID="project-discover-root" ref={setRootInputRef} mode="outlined" label={t('project:discoverRoot')} value={scanRoot} onChangeText={changeRoot} autoCapitalize="none" autoCorrect={false} autoFocus={!scanRoot} editable={!addingSelected} />
      {v1Connection ? <Text testID="project-discover-v1-hint" style={{ color: palette.muted }}>{t('project:discoverV1Hint')}</Text> : null}
      {scanError ? <Text testID="project-discover-scan-error" style={{ color: palette.danger }}>{scanError}</Text> : null}
      {scanning ? <>
        <Text testID="project-discover-progress">{t('project:discoverScanning', { count: scanCount })}</Text>
        <Button testID="project-discover-cancel" onPress={cancelScan}>{t('project:discoverCancel')}</Button>
      </> : <>
        <Button testID="project-discover-start" mode="contained" disabled={!scanRoot.trim() || addingSelected} onPress={startScan}>{t('project:discoverStart')}</Button>
        {scanned ? <>
          {/* Only the candidate rows scroll; the warnings and the add action stay
              pinned so a long result list cannot push them off-screen. */}
          <ScrollView testID="project-discover-results" style={[styles.resultScroll, { maxHeight: Math.min(320, windowHeight * 0.35) }]}
            contentContainerStyle={styles.resultList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {candidates.map((candidate, index) => {
              const selected = !candidate.exists && selectedPaths.includes(candidate.path);
              return <Pressable key={candidate.path} testID={`project-discover-item-${index}`} accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: candidate.exists }} disabled={candidate.exists}
                onPress={() => toggleCandidate(candidate.path)} style={styles.resultRow}>
                <Checkbox status={selected ? 'checked' : 'unchecked'} disabled={candidate.exists} />
                <View style={{ flex: 1 }}>
                  <Text testID={`project-discover-path-${index}`} style={{ color: candidate.exists ? palette.muted : palette.text }}>{candidate.path}</Text>
                  {candidate.exists ? <Text style={{ color: palette.muted }}>{t('project:discoverExisting')}</Text> : null}
                </View>
              </Pressable>;
            })}
            {candidates.length === 0 ? <Text testID="project-discover-empty">{t('project:discoverEmpty')}</Text> : null}
            {candidates.length > 0 && candidates.every((candidate) => candidate.exists)
              ? <Text testID="project-discover-all-existing">{t('project:discoverAllExisting', { count: candidates.length })}</Text> : null}
          </ScrollView>
          {cancelledScan ? <Text testID="project-discover-cancelled" style={{ color: palette.warning }}>{t('project:discoverCancelled')}</Text> : null}
          {truncated ? <Text testID="project-discover-truncated" style={{ color: palette.warning }}>{t('project:discoverTruncated')}</Text> : null}
          {skipped > 0 ? <Text testID="project-discover-skipped" style={{ color: palette.warning }}>{t('project:discoverSkipped', { count: skipped })}</Text> : null}
          {failedReads > 0 ? <Text testID="project-discover-failed-reads" style={{ color: palette.warning }}>{t('project:discoverFailedReads', { count: failedReads })}</Text> : null}
          {resultsStale ? <Text testID="project-discover-stale" style={{ color: palette.warning }}>{t('project:discoverStale')}</Text> : null}
          {addErrors.length ? <View testID="project-discover-error">
            {addErrors.map((failure, index) => <Text key={`${failure.path}:${index}`} testID={`project-discover-error-${index}`} style={{ color: palette.danger }}>
              {failure.path
                ? t('project:discoverAddFailedPath', { path: failure.path, message: failure.message })
                : failure.message}
            </Text>)}
          </View> : null}
          <View style={styles.formActions}>
            <Button onPress={backToAdd} disabled={addingSelected}>{t('common:actions.cancel')}</Button>
            <Button testID="project-discover-add" mode="contained" loading={addingSelected}
              disabled={addingSelected || resultsStale || selectedPaths.length === 0} onPress={addSelected}>
              {t('project:discoverAddSelected', { count: selectedPaths.length })}
            </Button>
          </View>
        </> : null}
      </>}
    </View> : <View style={styles.addForm}>
      <Text style={{ color: palette.muted }}>{t('project:picker.enterPath')}</Text>
      {multipleServers ? <WorkspaceSelect title={t('common:servers.server')} value={addServer} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={changeServer} /> : null}
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
  resultsForm: { flex: 1, minHeight: 0 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  resultScroll: { flex: 1, minHeight: 0 },
  resultList: { gap: 2 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
});
