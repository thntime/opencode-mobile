import { describe, expect, it, vi } from 'vitest';
import { deferred, hookRuntime, loadTs } from '../helpers/runtime.mjs';

type Element = { type: unknown; props: Record<string, any> };

function find(root: any, testID: string): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, testID)).find(Boolean);
  if (!root || typeof root !== 'object') return;
  if (root.props?.testID === testID || root.type === testID) return root;
  return find(root.props?.children, testID);
}

const t = (key: string, params?: Record<string, unknown>) => {
  if (params && 'count' in params) return `${key}:${params.count}`;
  if (params && 'message' in params) return `${key}:${params.message}`;
  return key;
};

function deferredGate<T = void>() {
  return deferred() as unknown as { promise: Promise<T>; resolve: (value: T) => void };
}

type PickerOptions = {
  focusPath?: string;
  projects?: string[];
  scanResult?: Record<string, unknown>;
  scanImpl?: (options: any) => Promise<unknown>;
};

async function picker(options: PickerOptions = {}) {
  const runtime = hookRuntime();
  const add = vi.fn(async (_connectionId: string, path: string) => ({ connectionId: 'c1', projectPath: path }));
  const remove = vi.fn(async () => undefined);
  const activate = vi.fn(async () => undefined);
  const retry = vi.fn(async () => undefined);
  const registry = {
    connections: [{ id: 'c1', name: 'Server', enabled: true, settings: { directory: '' } }],
    snapshots: {},
    focus: options.focusPath === undefined ? undefined : { connectionId: 'c1', projectPath: options.focusPath },
    activate,
    retry,
  };
  const groups = [{
    id: 'c1',
    name: 'Server',
    enabled: true,
    status: 'connected',
    projects: (options.projects ?? []).map((path) => ({ path, label: path })),
  }];
  const scanListDirectory = vi.fn(async () => [{ name: '.opencode', type: 'directory' as const }]);
  const buildScanListDirectory = vi.fn(() => scanListDirectory);
  const resolveScanRoot = vi.fn((_client: unknown, directory: string) => directory.trim().replace(/\/+$/, ''));
  const buildClient = vi.fn(() => ({ __opencode: { contract: 'v2', directory: '' } }));
  const scanForProjects = vi.fn(options.scanImpl ?? (async () => options.scanResult ?? {
    candidates: [], truncated: false, skippedForPermission: 0,
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
      Pressable: 'Pressable',
      StyleSheet: { create: (styles: unknown) => styles },
      Text: 'NativeText',
      View: 'View',
    },
    'react-native-paper': { Button: 'Button', Checkbox: 'Checkbox', Text: 'Text' },
    '@/components/project/worktree-picker': { WorktreePicker: 'WorktreePicker' },
    '@/components/ui/workspace-select': { WorkspaceSelect: 'WorkspaceSelect' },
    '@/components/onboarding/project-options': { ProjectOptions: 'ProjectOptions' },
    '@/providers/workspace-context': { useWorkspaces: () => registry },
    '@/providers/use-workspace-projects': { useWorkspaceProjects: () => ({ groups, add, remove }) },
    '@/constants/theme': { Colors: { light: { tint: '#000', muted: '#777', danger: '#f00', text: '#000', surface: '#fff', border: '#ccc' } } },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    './overlay-sheet': { OverlaySheet: 'OverlaySheet' },
    './text-input': { TextInput: 'Input' },
    '@/lib/opencode/client': { buildClient },
    '@/providers/services/project-discovery-service': {
      buildScanListDirectory,
      resolveScanRoot,
      normalizeScanPath: (value: string) => value.trim().replace(/\/+$/, ''),
    },
    '@/lib/project-discovery': { scanForProjects },
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
  const press = async (id: string) => { element(id).props.onPress(); await runtime.settle(); };
  const openDiscover = async () => { await press('project-add-button'); await press('project-discover-open'); };
  return {
    runtime, add, remove, activate, retry, groups, registry,
    scanForProjects, scanListDirectory, buildScanListDirectory, resolveScanRoot, buildClient,
    onClose, onSelected, element, press, openDiscover,
  };
}

describe('project picker discovery', () => {
  it('offers a discover entry from the add form and prefills the parent of the active project', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.press('project-add-button');
    view.element('project-discover-open');
    await view.press('project-discover-open');
    expect(view.element('project-discover-root').props.value).toBe('/home/u/work');
  });

  it('leaves the root empty and disables scanning when no project is active', async () => {
    const view = await picker();
    await view.openDiscover();
    expect(view.element('project-discover-root').props.value).toBe('');
    expect(view.element('project-discover-start').props.disabled).toBe(true);
  });

  it('scans the resolved root with the selected connection client', async () => {
    const view = await picker({ focusPath: '/home/u/work/app' });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.buildClient).toHaveBeenCalled();
    expect(view.resolveScanRoot).toHaveBeenCalledWith(expect.anything(), '/home/u/work');
    expect(view.buildScanListDirectory).toHaveBeenCalledWith(expect.anything());
    expect(view.scanForProjects).toHaveBeenCalledOnce();
    expect(view.scanForProjects.mock.calls[0][0].root).toBe('/home/u/work');
  });

  it('shows the live count and stops the scan when cancelled', async () => {
    const gate = deferredGate<undefined>();
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanImpl: async (scanOptions: any) => {
        await scanOptions.listDirectory('/home/u/work/app');
        await gate.promise;
        return {
          candidates: [{ path: '/home/u/work/app', exists: false }],
          truncated: false,
          skippedForPermission: 0,
          reason: scanOptions.signal.cancelled ? 'cancelled' : undefined,
        };
      },
    });
    await view.openDiscover();
    view.element('project-discover-start').props.onPress();
    await view.runtime.settle();
    expect(view.element('project-discover-progress').props.children).toContain('project:discoverScanning:1');
    const scanOptions = view.scanForProjects.mock.calls[0][0];
    await view.press('project-discover-cancel');
    expect(scanOptions.signal.cancelled).toBe(true);
    // Already discovered candidates stay visible after cancelling.
    expect(view.element('project-discover-item-0').props.disabled).toBe(false);
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
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
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    const existing = view.element('project-discover-item-1');
    expect(existing.props.disabled).toBe(true);
    expect(existing.props.accessibilityState).toMatchObject({ disabled: true, checked: false });
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
    await view.press('project-discover-item-1');
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
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
      },
    });
    view.add.mockImplementationOnce(() => first.promise);
    await view.openDiscover();
    await view.press('project-discover-start');
    view.element('project-discover-add').props.onPress();
    await view.runtime.settle();
    expect(view.add).toHaveBeenCalledTimes(1);
    expect(view.add.mock.calls[0]).toEqual(['c1', '/home/u/work/a']);
    first.resolve?.({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    await view.runtime.settle();
    expect(view.add.mock.calls.map((call) => call[1])).toEqual(['/home/u/work/a', '/home/u/work/b']);
    expect(view.activate).not.toHaveBeenCalled();
    view.element('project-add-button');
  });

  it('activates and closes after adding a single project', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [{ path: '/home/u/work/a', exists: false }],
        truncated: false,
        skippedForPermission: 0,
      },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-add');
    expect(view.activate).toHaveBeenCalledWith({ connectionId: 'c1', projectPath: '/home/u/work/a' });
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('keeps going after a failure and reports the first error', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: {
        candidates: [
          { path: '/home/u/work/a', exists: false },
          { path: '/home/u/work/b', exists: false },
        ],
        truncated: false,
        skippedForPermission: 0,
      },
    });
    view.add.mockRejectedValueOnce(new Error('boom'));
    await view.openDiscover();
    await view.press('project-discover-start');
    await view.press('project-discover-add');
    expect(view.add).toHaveBeenCalledTimes(2);
    expect(view.element('project-discover-error').props.children).toBe('project:discoverFailed:boom');
    // The project that did succeed is marked as already added; the failure stays
    // selectable so it can be retried.
    expect(view.element('project-discover-item-1').props.disabled).toBe(true);
    expect(view.element('project-discover-item-0').props.disabled).toBe(false);
    expect(view.element('project-discover-add').props.children).toContain('project:discoverAddSelected:1');
  });

  it('surfaces truncation and permission skips', async () => {
    const view = await picker({
      focusPath: '/home/u/work/app',
      scanResult: { candidates: [], truncated: true, skippedForPermission: 2 },
    });
    await view.openDiscover();
    await view.press('project-discover-start');
    expect(view.element('project-discover-truncated').props.children).toBe('project:discoverTruncated');
    expect(view.element('project-discover-skipped').props.children).toBe('project:discoverSkipped:2');
    expect(view.element('project-discover-empty').props.children).toBe('project:discoverEmpty');
  });
});
