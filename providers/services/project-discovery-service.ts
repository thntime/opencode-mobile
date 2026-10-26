import type { ScopedOpencodeClient } from '@/lib/opencode/client';
import { normalizeScanPath, scanErrorCode, scanErrorStatus } from '@/lib/project-discovery';

// Provider-facing adapter for the project discovery scanner: it turns the
// per-directory `file.list` call into a `{ name, type }` listing so the
// traversal in `lib/project-discovery.ts` stays transport-agnostic.
export type ScanDirectoryEntry = { name: string; type: 'file' | 'directory' };
export type ScanListDirectory = (directory: string) => Promise<ScanDirectoryEntry[]>;

export type ScanErrorCode =
  | 'scan_root_required'
  | 'scan_root_relative'
  | 'scan_scope_v1'
  | 'scan_unsupported'
  | 'scan_connection_missing'
  | 'scan_directory_unreadable';

/**
 * Typed scan failure. `code` lets the UI pick a localized message instead of
 * rendering an English transport string; `status`/`errno` keep the upstream
 * classification available to the scanner.
 */
export class ScanError extends Error {
  readonly code: ScanErrorCode;
  readonly status?: number;
  readonly errno?: string;

  constructor(code: ScanErrorCode, message?: string, options: { status?: number; errno?: string } = {}) {
    super(message ?? code);
    this.name = 'ScanError';
    this.code = code;
    this.status = options.status;
    this.errno = options.errno;
  }
}

function isInsideScope(directory: string, scope: string): boolean {
  return directory === scope || scope === '/' || directory.startsWith(`${scope}/`);
}

function relativeToScope(directory: string, scope: string): string {
  if (directory === scope) return '';
  return scope === '/' ? directory.slice(1) : directory.slice(scope.length + 1);
}

async function readDirectory<Entry>(directory: string, run: () => Promise<{ data?: Entry[] | undefined }>): Promise<Entry[]> {
  let response: { data?: Entry[] | undefined };
  try {
    response = await run();
  } catch (error) {
    const status = scanErrorStatus(error);
    const errno = scanErrorCode(error);
    throw new ScanError(
      'scan_directory_unreadable',
      status === undefined ? `Could not read directory: ${directory}` : `Could not read directory: ${directory} (HTTP ${status})`,
      { status, errno },
    );
  }
  // An empty directory legitimately lists zero entries; only a missing payload
  // means the request did not produce a listing.
  if (response?.data == null) {
    throw new ScanError('scan_directory_unreadable', `Could not read directory: ${directory} (empty response)`);
  }
  return response.data;
}

export function resolveScanRoot(client: ScopedOpencodeClient, directory: string): string {
  const root = normalizeScanPath(directory);
  if (!root) throw new ScanError('scan_root_required', 'Enter a directory to scan.');
  if (!root.startsWith('/')) throw new ScanError('scan_root_relative', 'Scan root must be an absolute path.');
  if (client.compatibility) {
    // V1 has no `location` parameter, so a scan cannot leave the project the
    // connection was opened with.
    const scope = normalizeScanPath(client.__opencode.directory ?? '');
    if (!scope || !isInsideScope(root, scope)) {
      throw new ScanError('scan_scope_v1', 'This connection can only scan directories inside the current project.');
    }
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
      return entries.map((entry) => ({
        // V1 entries may omit `name`; the final path segment is the child name.
        name: entry.name || entry.path.split('/').pop() || '',
        type: entry.type,
      }));
    }
    if (!client.api) throw new ScanError('scan_unsupported', 'This connection cannot scan directories.');
    const entries = await readDirectory(root, () => client.api!.file.list({ location: { directory: root }, path: '.' }));
    return entries.map((entry) => ({ name: entry.path.replace(/\/+$/, ''), type: entry.type }));
  };
}
