import { useCallback } from 'react';

import { buildClient } from '@/lib/opencode/client';
import { normalizeScanPath, parentScanPath, scanForProjects, type ScanResult } from '@/lib/project-discovery';
import { buildScanListDirectory, resolveScanRoot, ScanError } from '@/providers/services/project-discovery-service';
import { useWorkspaceProjects } from '@/providers/use-workspace-projects';
import { useWorkspaces } from '@/providers/workspace-context';
import type { WorkspaceSnapshot } from '@/providers/workspace-types';

export type ProjectScanProgress = { found: string[] };

export type ProjectScanOptions = {
  signal?: { cancelled: boolean };
  onProgress?: (progress: ProjectScanProgress) => void;
  /** Active project path from the caller when no focused snapshot is available. */
  fallbackPath?: string;
};

function snapshotFor(snapshots: Record<string, WorkspaceSnapshot>, connectionId: string): WorkspaceSnapshot | undefined {
  return Object.entries(snapshots)
    .find(([key]) => (JSON.parse(key) as string[])[0] === connectionId)?.[1];
}

/**
 * Provider-side orchestration for project discovery. The picker supplies local
 * UI state only; client construction, snapshot lookups, root resolution, and
 * progress reporting live here so `components/` never touches transport code.
 */
export function useProjectDiscovery() {
  const registry = useWorkspaces();
  const { groups } = useWorkspaceProjects();
  const { connections, focus, snapshots } = registry;

  const contractFor = useCallback((connectionId: string) => snapshotFor(snapshots, connectionId)
    ?.values.connectionValue.serverCapabilities.contract ?? 'v2', [snapshots]);

  const isV1 = useCallback((connectionId: string) => contractFor(connectionId) === 'v1', [contractFor]);

  const activeProjectFor = useCallback((connectionId: string, fallbackPath?: string) => {
    if (!connectionId) return '';
    if (focus?.connectionId === connectionId && focus.projectPath) return focus.projectPath;
    if (fallbackPath) return fallbackPath;
    const snapshot = snapshotFor(snapshots, connectionId);
    return snapshot?.values.projectsValue.activeProjectPath
      || connections.find((entry) => entry.id === connectionId)?.settings.directory
      || '';
  }, [connections, focus, snapshots]);

  const resolveDefaultRoot = useCallback((connectionId: string, fallbackPath?: string) => {
    const project = normalizeScanPath(activeProjectFor(connectionId, fallbackPath));
    if (!project) return '';
    // V1 can only list paths inside the project it was opened with, so the
    // project itself is the widest safe default. V2 scans its parent.
    return isV1(connectionId) ? project : parentScanPath(project);
  }, [activeProjectFor, isV1]);

  const projectsFor = useCallback((connectionId: string) => groups
    .find((group) => group.id === connectionId)
    ?.projects.map((project) => project.path) ?? [], [groups]);

  const scan = useCallback(async (
    connectionId: string,
    root: string,
    options: ProjectScanOptions = {},
  ): Promise<ScanResult> => {
    const entry = connections.find((item) => item.id === connectionId);
    if (!entry) throw new ScanError('scan_connection_missing', 'This server is no longer available.');
    const contract = contractFor(connectionId);
    // The client scope only matters for V1 compatibility; V2 listings use the
    // scanned directory as `location[directory]` for every request.
    const client = buildClient({ ...entry.settings, directory: activeProjectFor(connectionId, options.fallbackPath) || root }, contract);
    const listDirectory = buildScanListDirectory(client);
    const resolvedRoot = resolveScanRoot(client, root);
    const existingPaths = projectsFor(connectionId);
    const found: string[] = [];

    return scanForProjects({
      root: resolvedRoot,
      existingPaths,
      signal: options.signal,
      listDirectory: async (path) => {
        const entries = await listDirectory(path);
        if (!options.signal?.cancelled && entries.some((item) => item.type === 'directory' && item.name === '.opencode')) {
          found.push(path);
          options.onProgress?.({ found: [...found] });
        }
        return entries;
      },
    });
  }, [activeProjectFor, connections, contractFor, projectsFor]);

  const refreshProjects = useCallback(async (connectionId: string) => {
    const runtimes = Object.entries(snapshots)
      .filter(([key]) => (JSON.parse(key) as string[])[0] === connectionId)
      .map(([, snapshot]) => snapshot);
    await Promise.all(runtimes.map((runtime) => runtime.values.projectsValue
      .refreshProjectCatalog(true).catch(() => undefined)));
  }, [snapshots]);

  return { scan, resolveDefaultRoot, isV1, refreshProjects };
}
