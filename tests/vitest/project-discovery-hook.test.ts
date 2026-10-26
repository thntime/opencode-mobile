import { describe, expect, it, vi } from 'vitest';
import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

async function discovery(options: { contract?: 'v1' | 'v2'; focusPath?: string } = {}) {
  const runtime = hookRuntime();
  const contract = options.contract ?? 'v2';
  const focusPath = options.focusPath ?? '/repo/app';
  const listDirectory = vi.fn(async () => [{ name: '.opencode', type: 'directory' as const }]);
  const buildClient = vi.fn(() => ({ __opencode: { contract, directory: focusPath } }));
  const resolveScanRoot = vi.fn((_client: unknown, directory: string) => directory.trim().replace(/\/+$/, ''));
  const buildScanListDirectory = vi.fn(() => listDirectory);
  const scanForProjects = vi.fn(async (scanOptions: any) => {
    await scanOptions.listDirectory('/work/app');
    return { candidates: [], truncated: false, skippedForPermission: 0, failedReads: 0 };
  });
  class ScanError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  }
  const refreshProjectCatalog = vi.fn(async () => undefined);
  const snapshot = {
    values: {
      connectionValue: { serverCapabilities: { contract } },
      projectsValue: { activeProjectPath: focusPath, refreshProjectCatalog },
    },
  };
  const registry = {
    connections: [{ id: 'c1', name: 'Server', enabled: true, settings: { directory: '' } }],
    focus: { connectionId: 'c1', projectPath: focusPath },
    snapshots: { [JSON.stringify(['c1', focusPath])]: snapshot },
  };
  const groups = [{ id: 'c1', projects: [{ path: '/repo/a', label: 'a' }] }];
  const { useProjectDiscovery } = await loadTs('providers/use-project-discovery.ts', {
    react: runtime.react,
    '@/lib/opencode/client': { buildClient },
    '@/lib/project-discovery': {
      normalizeScanPath: (value: string) => value.trim().replace(/\/{2,}/g, '/').replace(/\/+$/, ''),
      parentScanPath: (value: string) => {
        const path = value.trim().replace(/\/+$/, '');
        const index = path.lastIndexOf('/');
        return index <= 0 ? '/' : path.slice(0, index);
      },
      scanForProjects,
    },
    '@/providers/services/project-discovery-service': {
      buildScanListDirectory,
      resolveScanRoot,
      ScanError,
    },
    '@/providers/workspace-context': { useWorkspaces: () => registry },
    '@/providers/use-workspace-projects': { useWorkspaceProjects: () => ({ groups }) },
  }, { Error });

  const value = runtime.mount(useProjectDiscovery, {});
  return {
    value,
    buildClient,
    resolveScanRoot,
    buildScanListDirectory,
    listDirectory,
    scanForProjects,
    refreshProjectCatalog,
  };
}

describe('useProjectDiscovery', () => {
  it('resolves the V2 default root to the parent of the active project', async () => {
    const view = await discovery({ contract: 'v2', focusPath: '/repo/app' });
    expect(view.value.resolveDefaultRoot('c1')).toBe('/repo');
    expect(view.value.isV1('c1')).toBe(false);
  });

  it('resolves the V1 default root to the current project itself', async () => {
    const view = await discovery({ contract: 'v1', focusPath: '/repo/app' });
    expect(view.value.resolveDefaultRoot('c1')).toBe('/repo/app');
    expect(view.value.isV1('c1')).toBe(true);
  });

  it('builds the client from the connection and reports progress from the scanner', async () => {
    const view = await discovery();
    const progress = vi.fn();

    const result = await view.value.scan('c1', '/work/', { onProgress: progress });

    expect(result).toMatchObject({ truncated: false, failedReads: 0 });
    expect(view.buildClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/repo/app' }),
      'v2',
    );
    expect(view.resolveScanRoot).toHaveBeenCalledWith(expect.anything(), '/work/');
    expect(view.scanForProjects).toHaveBeenCalledWith(expect.objectContaining({
      root: '/work',
      existingPaths: ['/repo/a'],
    }));
    expect(view.listDirectory).toHaveBeenCalledWith('/work/app');
    expect(progress).toHaveBeenCalledWith({ found: ['/work/app'] });
  });

  it('refreshes the project catalog for every runtime of the connection', async () => {
    const view = await discovery();
    await view.value.refreshProjects('c1');
    expect(view.refreshProjectCatalog).toHaveBeenCalledWith(true);
  });

  it('rejects an unknown connection with a typed error', async () => {
    const view = await discovery();
    await expect(view.value.scan('missing', '/work')).rejects.toMatchObject({ code: 'scan_connection_missing' });
  });
});
