import type { ScopedOpencodeClient } from '@/lib/opencode/client';

// Provider-facing adapter for the project discovery scanner: it turns the
// per-directory `file.list` call into a `{ name, type }` listing so the
// traversal in `lib/project-discovery.ts` stays transport-agnostic.
export type ScanDirectoryEntry = { name: string; type: 'file' | 'directory' };
export type ScanListDirectory = (directory: string) => Promise<ScanDirectoryEntry[]>;

const V1_SCOPE_ERROR = 'This connection can only scan directories inside the current project.';

// Remote paths are POSIX-style; `path` would apply host-specific semantics.
export function normalizeScanPath(directory: string): string {
  const collapsed = directory.trim().replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function isInsideScope(directory: string, scope: string): boolean {
  return directory === scope || scope === '/' || directory.startsWith(`${scope}/`);
}

function relativeToScope(directory: string, scope: string): string {
  if (directory === scope) return '';
  return scope === '/' ? directory.slice(1) : directory.slice(scope.length + 1);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; response?: { status?: unknown } };
  const status = record.status ?? record.response?.status;
  return typeof status === 'number' ? status : undefined;
}

async function readDirectory<Entry>(directory: string, run: () => Promise<{ data?: Entry[] | undefined }>): Promise<Entry[]> {
  let response: { data?: Entry[] | undefined };
  try {
    response = await run();
  } catch (error) {
    const status = errorStatus(error);
    throw new Error(status === undefined ? `Could not read directory: ${directory}` : `Could not read directory: ${directory} (HTTP ${status})`);
  }
  // An empty directory legitimately lists zero entries; only a missing payload
  // means the request did not produce a listing.
  if (response?.data == null) throw new Error(`Could not read directory: ${directory} (empty response)`);
  return response.data;
}

export function resolveScanRoot(client: ScopedOpencodeClient, directory: string): string {
  const root = normalizeScanPath(directory);
  if (!root) throw new Error('Enter a directory to scan.');
  if (!root.startsWith('/')) throw new Error('Scan root must be an absolute path.');
  if (client.compatibility) {
    // V1 has no `location` parameter, so a scan cannot leave the project the
    // connection was opened with.
    const scope = normalizeScanPath(client.__opencode.directory ?? '');
    if (!scope || !isInsideScope(root, scope)) throw new Error(V1_SCOPE_ERROR);
  }
  return root;
}

export function buildScanListDirectory(client: ScopedOpencodeClient): ScanListDirectory {
  return async (directory) => {
    const root = resolveScanRoot(client, directory);
    if (client.compatibility) {
      const scope = normalizeScanPath(client.__opencode.directory ?? '');
      const path = relativeToScope(root, scope);
      const entries = await readDirectory(root, () => client.compatibility!.file.list({ path }));
      return entries.map((entry) => ({ name: entry.name || entry.path.replace(/\/+$/, ''), type: entry.type }));
    }
    if (!client.api) throw new Error('This connection cannot scan directories.');
    const entries = await readDirectory(root, () => client.api!.file.list({ location: { directory: root }, path: '.' }));
    return entries.map((entry) => ({ name: entry.path.replace(/\/+$/, ''), type: entry.type }));
  };
}
