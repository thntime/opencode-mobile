import { describe, expect, it, vi } from 'vitest';
import { deferred, hookRuntime, loadTs } from '../helpers/runtime.mjs';

type Element = { type: unknown; props: Record<string, any> };

function find(root: any, testID: string): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, testID)).find(Boolean);
  if (!root || typeof root !== 'object') return;
  if (root.props?.testID === testID || root.type === testID) return root;
  return find(root.props?.children, testID);
}

function ancestors(root: any, testID: string, trail: any[] = []): any[] | undefined {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = ancestors(child, testID, trail);
      if (found) return found;
    }
    return undefined;
  }
  if (!root || typeof root !== 'object') return undefined;
  if (root.props?.testID === testID || root.type === testID) return trail;
  return ancestors(root.props?.children, testID, [...trail, root]);
}

function parentDirectory(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : trimmed.slice(0, index);
}

const t = (key: string, params?: Record<string, unknown>) => {
  if (params && 'path' in params && 'message' in params) return `${key}:${params.path}:${params.message}`;
  if (params && 'count' in params) return `${key}:${params.count}`;
  if (params && 'message' in params) return `${key}:${params.message}`;
  return key;
};

function deferredGate<T = void>() {
  return deferred() as unknown as { promise: Promise<T>; resolve: (value: T) => void };
}

type ServerOption = { id: string; name: string; projects?: string[] };

type PickerOptions = {
  focusPath?: string;
  focusConnectionId?: string;
  projects?: string[];
  servers?: ServerOption[];
  defaultRoots?: Record<string, string>;
  v1?: Record<string, boolean>;
  scanResult?: Record<string, unknown>;
  scanImpl?: (connectionId: string, root: string, options: any) => Promise<unknown>;
  window?: { width: number; height: number };
};

async function picker(options: PickerOptions = {}) {
  const runtime = hookRuntime();
  const add = vi.fn(async (_connectionId: string, path: string) => ({ connectionId: 'c1', projectPath: path }));
  const remove = vi.fn(async () => undefined);
  const activate = vi.fn(async () => undefined);
  const retry = vi.fn(async () => undefined);
  const serverList = options.servers ?? [{ id: 'c1', name: 'Server' }];
  const registry = {
    connections: serverList.map((server) => ({ id: server.id, name: server.name, enabled: true, settings: { directory: '' } })),
    snapshots: {},
    focus: options.focusPath === undefined ? undefined : {
      connectionId: options.focusConnectionId ?? serverList[0].id,
      projectPath: options.focusPath,
    },
    activate,
    retry,
  };
  const groups = serverList.map((server) => ({
    id: server.id,
    name: server.name,
    enabled: true,
    status: 'connected',
    projects: (server.projects ?? options.projects ?? []).map((path) => ({ path, label: path })),
  }));
  const resolveDefaultRoot = vi.fn((connectionId: string) => options.defaultRoots?.[connectionId]
    ?? (options.focusPath ? (options.v1?.[connectionId] ? options.focusPath : parentDirectory(options.focusPath)) : ''));
  const isV1 = vi.fn((connectionId: string) => Boolean(options.v1?.[connectionId]));
  const refreshProjects = vi.fn(async () => undefined);
  const dismissKeyboard = vi.fn();
  const scan = vi.fn(options.scanImpl ?? (async () => options.scanResult ?? {
    candidates: [], truncated: false, skippedForPermission: 0, failedReads: 0,
  }));
  const { ProjectPicker } = await loadTs('components/ui/project-picker.tsx', {
    react: runtime.react,
    'react/jsx-runtime': {
      jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
      jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
      Fragment: 'Fragment',
    },
    '@expo/vector-icons': { MaterialCommunityIcons: 'Icon' },
    'react-i18next': { useTranslation: () => ({ t }) },
    'react-native': {
      Keyboard: { dismiss: dismissKeyboard },
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      StyleSheet: { create: (styles: unknown) => styles },
      Text: 'NativeText',
      useWindowDimensions: () => options.window ?? { width: 390, height: 844 },
      View: 'View',
    },
    'react-native-paper': { Button: 'Button', Checkbox: 'Checkbox', Text: 'Text' },
    '@/components/project/worktree-picker': { WorktreePicker: 'WorktreePicker' },
    '@/components/ui/workspace-select': { WorkspaceSelect: 'WorkspaceSelect' },
    '@/components/onboarding/project-options': { ProjectOptions: 'ProjectOptions' },
    '@/providers/workspace-context': { useWorkspaces: () => registry },
    '@/providers/use-workspace-projects': { useWorkspaceProjects: () => ({ groups, add, remove }) },
    '@/providers/use-project-discovery': { useProjectDiscovery: () => ({ scan, resolveDefaultRoot, isV1, refreshProjects }) },
    '@/constants/theme': { Colors: { light: { tint: '#000', muted: '#777', danger: '#f00', text: '#000', surface: '#fff', border: '#ccc' } } },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    './overlay-sheet': { OverlaySheet: 'OverlaySheet' },
    './text-input': { TextInput: 'Input' },
    '@/lib/project-discovery': { normalizeScanPath: (value: string) => value.trim().replace(/\/+$/, '') },
    '@/providers/projects-storage': { PROJECTS_MAX: 50 },
  }, { Error });

  const onClose = vi.fn();
  const onSelected = vi.fn();
  runtime.mount(ProjectPicker, {
    visible: true,
    onClose,
    activePath: options.focusPath,
    onSelected,
    testID: 'project-picker',
  });
  const element = (id: string) => {
    const value = find(runtime.value, id);
    if (!value) throw new Error(`Missing ${id}`);
    return value;
  };
  const maybe = (id: string) => find(runtime.value, id);
  const press = async (id: string) => { element(id).props.onPress(); await runtime.settle(); };
  const openDiscover = async () => { await press('project-add-button'); await press('project-discover-open'); };
  return {
    runtime, add, remove, activate, retry, groups, registry,
    scan, resolveDefaultRoot, isV1, refreshProjects, dismissKeyboard,
    onClose, onSelected, element, maybe, press, openDiscover,
  };
}

describe('project picker discovery', () => {
  it('offers a discover entry from the add form and prefills the parent of the active project', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.press('project-add-button');
    view.element('project-discover-open');
    await view.press('project-discover-open');
    expect(view.element('project-discover-root').props.value).toBe('/home/u/work');
    expect(view.resolveDefaultRoot).toHaveBeenCalledWith('c1', '/home/u/work/app');
  });

  it('leaves the root empty and disables scanning when no project is active', async () => {
    const view = await picker();
    await view.openDiscover();
    expect(view.element('project-discover-root').props.value).toBe('');
    expect(view.element('project-discover-start').props.disabled).toBe(true);
  });

  it('uses the current project as the V1 root and explains the scope', async () => {
    const view = await picker({ focusPath: '/home/u/work/app', v1: { c1: true } });
    await view.openDiscover();
    expect(view.element('project-discover-root').props.value).toBe('/home/u/work/app');
    expect(view.element('project-discover-v1-hint').props.children).toBe('project:discoverV1Hint');
  });

  it('scans the resolved root through the provider orchestration', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.scan).toHaveBeenCalledOnce();
    expect(view.scan.mock.calls[0][0]).toBe('c1');
    expect(view.scan.mock.calls[0][1]).toBe('/home/u/work');
    expect(view.scan.mock.calls[0][2]).toMatchObject({ signal: expect.anything() });
  });

  it('dismisses the keyboard before scanning so results are not covered', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.dismissKeyboard).toHaveBeenCalledOnce();
    expect(view.dismissKeyboard.mock.invocationCallOrder[0])
      .toBeLessThan(view.scan.mock.invocationCallOrder[0]);
  });

  it('leaves every candidate unselected until the user opts in', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
          { path: '/home/u/work/c', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-item-0').props.accessibilityState).toMatchObject({ checked: false });
    expect(view.element('project-discover-item-1').props.accessibilityState).toMatchObject({ checked: false });
    expect(view.element('project-discover-item-2').props.accessibilityState).toMatchObject({ checked: false });
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:0');
    expect(view.element('project-discover-add').props.disabled).toBe(true);
    await view.press('project-discover-item-0');
    expect(view.element('project-discover-item-0').props.accessibilityState).toMatchObject({ checked: true });
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
    expect(view.element('project-discover-add').props.disabled).toBe(false);
  });

  it('keeps the add action outside the scrolling result list', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: Array.from({ length: 8 }, (_, index) => ({ path: `/home/u/work/p${index}`, exists: false })),
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    // The sheet itself stops scrolling in the results state so the warnings and
    // the add row stay pinned; only the inner list scrolls.
    expect(view.element('project-picker').props.scrollable).toBe(false);
    const list = view.element('project-discover-results');
    expect(list.type).toBe('ScrollView');
    const style = Object.assign({}, ...(Array.isArray(list.props.style) ? list.props.style : [list.props.style]));
    expect(style).toMatchObject({ flex: 1, minHeight: 0, maxHeight: expect.any(Number) });
    expect(style.maxHeight).toBeLessThanOrEqual(320);
    expect(style.maxHeight).toBeLessThanOrEqual(844 * 0.35);
    expect(find(list, 'project-discover-add')).toBeUndefined();
    expect(find(view.runtime.value, 'project-discover-add')).toBeTruthy();
    // No ScrollView ancestor at all: scrolling the outer sheet could not reveal
    // the fixed rows.
    expect(ancestors(view.runtime.value, 'project-discover-add')?.some((node) => node.type === 'ScrollView')).toBe(false);
  });

  it('keeps the sheet scrollable outside the results state', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.openDiscover();
    expect(view.element('project-picker').props.scrollable).toBe(true);
  });

  it('falls back to a scrollable sheet when the window is short and failures stack up', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      window: { width: 390, height: 390 },
      scanResult: {
        candidates: Array.from({ length: 10 }, (_, index) => ({ path: `/home/u/work/p${index}`, exists: false })),
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockRejectedValue(new Error('boom'));
    await view.openDiscover();
    await view.press('project-discover-start');
    for (let index = 0; index < 10; index += 1) await view.press(`project-discover-item-${index}`);
    await view.press('project-discover-add');

    // A 390pt-tall window cannot keep the fixed chrome pinned, so the sheet
    // itself scrolls instead of clipping the action row.
    expect(view.element('project-picker').props.scrollable).toBe(true);
    expect(view.element('project-discover-error-9')).toBeTruthy();
    const errors = view.element('project-discover-error');
    // The failure list has its own bounded scroll area and never swallows the
    // action row.
    expect(errors.type).toBe('ScrollView');
    const errorStyle = Object.assign({}, ...(Array.isArray(errors.props.style) ? errors.props.style : [errors.props.style]));
    expect(errorStyle.maxHeight).toBeGreaterThan(0);
    expect(errorStyle.maxHeight).toBeLessThanOrEqual(390 * 0.2);
    expect(find(errors, 'project-discover-add')).toBeUndefined();
    expect(find(view.element('project-discover-results'), 'project-discover-add')).toBeUndefined();
    // The action row stays in the document flow below the errors, outside every
    // inner scroll area; `scrollable` above makes the sheet itself the scroller
    // that can bring it into view.
    expect(ancestors(view.runtime.value, 'project-discover-add')?.some((node) => node.type === 'ScrollView')).toBe(false);
  });

  it('shows the live count and stops the scan when cancelled', async () => {
    const gate = deferredGate<undefined>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async (_connectionId: string, _root: string, scanOptions: any) => {
        scanOptions.onProgress({ found: ['/home/u/work/b', '/home/u/work/a'] });
        await gate.promise;
        return {
          candidates: [{ path: '/home/u/work/a', exists: false }, { path: '/home/u/work/b', exists: false }],
          truncated: false,
          skippedForPermission: 0,
          failedReads: 0,
          reason: scanOptions.signal.cancelled ? 'cancelled' : undefined,
        };
      },
    });
    await view.openDiscover();
    view.element('project-discover-start').props.onPress();
    await view.runtime.settle();
    expect(view.element('project-discover-progress').props.children).toContain('project:discoverScanning:2');
    const scanOptions = view.scan.mock.calls[0][2];
    await view.press('project-discover-cancel');
    expect(scanOptions.signal.cancelled).toBe(true);
    // Already discovered candidates stay visible after cancelling in the same
    // order a completed scan would use, and the UI says the result is partial.
    expect(view.element('project-discover-path-0').props.children).toBe('/home/u/work/a');
    expect(view.element('project-discover-path-1').props.children).toBe('/home/u/work/b');
    expect(view.element('project-discover-cancelled').props.children).toBe('project:discoverCancelled');
    // Cancelling is not the scan cap: the cap banner would contradict the
    // cancel banner and misreport why the list is partial.
    expect(view.maybe('project-discover-truncated')).toBeUndefined();
    expect(view.element('project-discover-item-0').props.disabled).toBe(false);
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:0');
    expect(view.element('project-discover-add').props.disabled).toBe(true);
    gate.resolve?.(undefined);
    await view.runtime.settle();
  });

  it('marks existing projects as already added and never selects them', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      projects: ['/home/u/work/b'],
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: true },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    const existing = view.element('project-discover-item-1');
    expect(existing.props.disabled).toBe(true);
    expect(existing.props.accessibilityState).toMatchObject({ disabled: true, checked: false });
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:0');
    await view.press('project-discover-item-1');
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:0');
    await view.press('project-discover-item-0');
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
    expect(view.element('project-discover-add').props.disabled).toBe(false);
    await view.press('project-discover-item-0');
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:0');
    expect(view.element('project-discover-add').props.disabled).toBe(true);
  });

  it('adds selected projects one at a time in list order and returns to the list when done', async () => {
    const first = deferredGate<{ connectionId: string; projectPath: string }>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockImplementationOnce(() => first.promise);
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();
    expect(view.add).toHaveBeenCalledTimes(1);
    expect(view.add.mock.calls[0]).toEqual(['c1', '/home/u/work/a']);
    first.resolve?.({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    await view.runtime.settle();
    expect(view.add.mock.calls.map((call) => call[1])).toEqual(['/home/u/work/a', '/home/u/work/b']);
    expect(view.activate).not.toHaveBeenCalled();
    expect(view.refreshProjects).toHaveBeenCalledWith('c1');
    view.element('project-add-button');
  });

  it('activates and closes after adding a single project', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: false }],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-add');
    expect(view.activate).toHaveBeenCalledWith({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('keeps going after a failure and reports every failed path', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
          { path: '/home/u/work/c', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockRejectedValueOnce(new Error('boom'));
    view.add.mockRejectedValueOnce(new Error('nope'));
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    await view.press('project-discover-item-2');
    await view.press('project-discover-add');
    expect(view.add).toHaveBeenCalledTimes(3);
    expect(view.element('project-discover-error-0').props.children).toBe('project:discoverAddFailedPath:/home/u/work/a:boom');
    expect(view.element('project-discover-error-1').props.children).toBe('project:discoverAddFailedPath:/home/u/work/b:nope');
    // The project that did succeed is marked as already added; the failures stay
    // selectable so they can be retried.
    expect(view.element('project-discover-item-2').props.disabled).toBe(true);
    expect(view.element('project-discover-item-0').props.disabled).toBe(false);
    expect(view.element('project-discover-item-1').props.disabled).toBe(false);
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:2');
  });

  it('surfaces truncation, permission skips, and failed reads', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: { candidates: [], truncated: true, skippedForPermission: 2, failedReads: 3 },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-truncated').props.children).toBe('project:discoverTruncated');
    expect(view.element('project-discover-skipped').props.children).toBe('project:discoverSkipped:2');
    expect(view.element('project-discover-failed-reads').props.children).toBe('project:discoverFailedReads:3');
    expect(view.element('project-discover-empty').props.children).toBe('project:discoverEmpty');
  });

  it('distinguishes an empty scan from a scan where every project already exists', async () => {
    const allExisting = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: true }],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await allExisting.openDiscover();
    await allExisting.press('project-discover-start');
    expect(allExisting.element('project-discover-all-existing').props.children).toBe('project:discoverAllExisting:1');
    expect(allExisting.maybe('project-discover-empty')).toBeUndefined();

    const empty = await picker({ focusPath: '/home/u/work/app' });
    await empty.openDiscover();
    await empty.press('project-discover-start');
    expect(empty.element('project-discover-empty').props.children).toBe('project:discoverEmpty');
    expect(empty.maybe('project-discover-all-existing')).toBeUndefined();
  });

  it('shows a localized error when the root cannot be read', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async () => { throw Object.assign(new Error('denied'), { code: 'scan_directory_unreadable', status: 403 }); },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-scan-error').props.children).toBe('project:discoverRootPermission');
  });

  it('shows the localized V1 scope error instead of an English transport message', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      v1: { c1: true },
      scanImpl: async () => { throw Object.assign(new Error('outside scope'), { code: 'scan_scope_v1' }); },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-scan-error').props.children).toBe('project:discoverV1Hint');
  });

  it('clears results and refills the root when the server changes', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      focusConnectionId: 'c1',
      servers: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }],
      defaultRoots: { c1: '/home/u/work', c2: '/srv/two' },
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: false }],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-item-0')).toBeTruthy();
    view.element('project-discover-server').props.onChange('c2');
    await view.runtime.settle();
    expect(view.element('project-discover-root').props.value).toBe('/srv/two');
    expect(view.maybe('project-discover-item-0')).toBeUndefined();
    expect(view.maybe('project-discover-add')).toBeUndefined();
    expect(view.resolveDefaultRoot).toHaveBeenCalledWith('c2', undefined);
  });

  it('clears results when the root input changes after a scan', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: false }],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-item-0')).toBeTruthy();
    view.element('project-discover-root').props.onChangeText('/home/u/other');
    await view.runtime.settle();
    expect(view.maybe('project-discover-item-0')).toBeUndefined();
    expect(view.element('project-discover-root').props.value).toBe('/home/u/other');
  });

  it('cancels an in-flight scan when the picker unmounts', async () => {
    const gate = deferredGate<unknown>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async (_connectionId: string, _root: string, scanOptions: any) => {
        await gate.promise;
        return { candidates: [], truncated: false, skippedForPermission: 0, failedReads: 0 };
      },
    });
    await view.openDiscover();
    view.element('project-discover-start').props.onPress();
    await view.runtime.settle();
    const scanOptions = view.scan.mock.calls[0][2];
    view.runtime.unmount();
    expect(scanOptions.signal.cancelled).toBe(true);
    gate.resolve?.(undefined);
  });

  it('cancels an in-flight scan when the sheet becomes invisible', async () => {
    const gate = deferredGate<unknown>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async (_connectionId: string, _root: string, scanOptions: any) => {
        await gate.promise;
        return { candidates: [], truncated: false, skippedForPermission: 0, failedReads: 0 };
      },
    });
    await view.openDiscover();
    view.element('project-discover-start').props.onPress();
    await view.runtime.settle();
    const scanOptions = view.scan.mock.calls[0][2];
    view.runtime.update({ visible: false });
    expect(scanOptions.signal.cancelled).toBe(true);
    gate.resolve?.(undefined);
  });

  it('shows the permission message for an EACCES root failure', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async () => { throw Object.assign(new Error('denied'), { code: 'scan_directory_unreadable', errno: 'EACCES' }); },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-scan-error').props.children).toBe('project:discoverRootPermission');
  });

  it('falls back to a localized message for an unexpected scan failure', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async () => { throw new Error('socket exploded'); },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-scan-error').props.children).toBe('project:discoverScanFailed');
  });

  it('blocks adding when the visible results belong to another connection', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: false }],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    // The connection changes without going through the picker's own selector.
    view.groups[0].id = 'c2';
    view.runtime.update({ visible: true });

    expect(view.element('project-discover-stale').props.children).toBe('project:discoverStale');
    expect(view.element('project-discover-add').props.disabled).toBe(true);
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();
    expect(view.add).not.toHaveBeenCalled();
  });

  it('ignores server and root changes while a batch is being added', async () => {
    const first = deferredGate<{ connectionId: string; projectPath: string }>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      focusConnectionId: 'c1',
      servers: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }],
      defaultRoots: { c1: '/home/u/work', c2: '/srv/two' },
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockImplementationOnce(() => first.promise);
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();

    // A second batch must not start while the first one is still running.
    view.element('project-discover-add').props.onPress();
    // Neither the server nor the root may change under the running batch.
    view.element('project-discover-server').props.onChange('c2');
    view.element('project-discover-root').props.onChangeText('/srv/two');
    await view.runtime.settle();

    expect(view.element('project-discover-server').props.disabled).toBe(true);
    expect(view.element('project-discover-root').props.editable).toBe(false);
    expect(view.element('project-discover-root').props.value).toBe('/home/u/work');
    expect(view.add).toHaveBeenCalledTimes(1);

    first.resolve?.({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    await view.runtime.settle();
    expect(view.add.mock.calls).toEqual([['c1', '/home/u/work/a'], ['c1', '/home/u/work/b']]);
    expect(view.refreshProjects).toHaveBeenCalledWith('c1');
  });

  it('stops the batch when the connection changes underneath it', async () => {
    const first = deferredGate<{ connectionId: string; projectPath: string }>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockImplementationOnce(() => first.promise);
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();

    view.groups[0].id = 'c2';
    view.runtime.update({ visible: true });
    first.resolve?.({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    await view.runtime.settle();

    expect(view.add).toHaveBeenCalledTimes(1);
    expect(view.activate).not.toHaveBeenCalled();
  });

  it('aborts the batch and resets the add action when the sheet closes mid-batch', async () => {
    const first = deferredGate<{ connectionId: string; projectPath: string }>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    view.add.mockImplementationOnce(() => first.promise);
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();
    expect(view.add).toHaveBeenCalledTimes(1);

    // Closing the sheet must stop the batch before it touches the next path.
    view.element('project-picker').props.onClose();
    await view.runtime.settle();
    first.resolve?.({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    await view.runtime.settle();
    expect(view.add).toHaveBeenCalledTimes(1);
    expect(view.activate).not.toHaveBeenCalled();
    expect(view.onClose).toHaveBeenCalledOnce();

    // The aborted batch must not leave the add action stuck in its loading state.
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    expect(view.element('project-discover-add').props.loading).toBe(false);
    expect(view.element('project-discover-add').props.disabled).toBe(false);
  });

  it('refuses a batch that would exceed the project cap', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      projects: Array.from({ length: 49 }, (_, index) => `/home/u/work/existing-${index}`),
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-item-0');
    await view.press('project-discover-item-1');
    await view.press('project-discover-add');

    expect(view.add).not.toHaveBeenCalled();
    expect(view.element('project-discover-error-0').props.children).toBe('project:discoverProjectLimit:1');
  });

  it('refuses to add more than the batch limit at once', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: Array.from({ length: 11 }, (_, index) => ({ path: `/home/u/work/p${index}`, exists: false })),
        truncated: false,
        skippedForPermission: 0,
        failedReads: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    for (let index = 0; index < 11; index += 1) await view.press(`project-discover-item-${index}`);
    await view.press('project-discover-add');
    expect(view.add).not.toHaveBeenCalled();
    expect(view.element('project-discover-error-0').props.children).toBe('project:discoverAddLimit:10');
  });
});
