// Breadth-first discovery of projects on a remote filesystem.
//
// A directory is a project when one of its direct children is an `.opencode`
// directory. Traversal is kept free of network and platform APIs: the caller
// injects `listDirectory`, so the scan can be unit tested with a fake tree and
// the real implementation only maps `file.list` onto that interface.
//
// Limits are deliberate: the entry cap bounds the work, the duration cap bounds
// the worst-case wait, and the concurrency cap bounds the burst on the tunnel.
// Whenever a cap is hit the scan stops dispatching, keeps what it already
// found, and reports `truncated: true`.

export type DirectoryEntry = { name: string; type: 'file' | 'directory' };

export type ListDirectory = (absolutePath: string) => Promise<DirectoryEntry[]>;

export type ScanCandidate = { path: string; exists: boolean };

export type ScanLimits = {
  maxEntries?: number;
  maxDurationMs?: number;
  concurrency?: number;
};

export type ScanResult = {
  candidates: ScanCandidate[];
  truncated: boolean;
  skippedForPermission: number;
  reason?: 'max-entries' | 'max-duration' | 'cancelled';
};

export const DEFAULT_SCAN_LIMITS: Required<ScanLimits> = {
  maxEntries: 2000,
  maxDurationMs: 15000,
  concurrency: 4,
};

// Directories that never contain a project worth discovering but can hold huge
// trees. Skipping them keeps the budget for real projects.
export const PRUNED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '.cache',
  'target',
  '.venv',
  'venv',
  '__pycache__',
];

const PRUNED_DIRECTORY_SET = new Set(PRUNED_DIRECTORIES);

type QueueItem = { path: string; order: number };

type ListOutcome =
  | { item: QueueItem; ok: true; entries: DirectoryEntry[] }
  | { item: QueueItem; ok: false; error: unknown };

/** Drops trailing slashes while keeping the filesystem root intact. */
function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (/^\/+$/.test(trimmed)) return '/';
  return trimmed.replace(/\/+$/, '');
}

/** Joins with `/` (the server is Linux); no platform path API is involved. */
function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/**
 * Scans `root` breadth-first for directories that directly contain an
 * `.opencode` directory.
 *
 * Directories are visited in BFS order and candidates are returned in that
 * same discovery order, even when concurrent listings finish out of order.
 * A root listing failure is rethrown (the UI needs to tell the user the root is
 * inaccessible); failures below the root only increment `skippedForPermission`.
 */
export async function scanForProjects(options: {
  root: string;
  listDirectory: ListDirectory;
  existingPaths?: string[];
  limits?: ScanLimits;
  signal?: { cancelled: boolean };
  now?: () => number;
}): Promise<ScanResult> {
  const { root, listDirectory, signal } = options;
  const maxEntries = options.limits?.maxEntries ?? DEFAULT_SCAN_LIMITS.maxEntries;
  const maxDurationMs = options.limits?.maxDurationMs ?? DEFAULT_SCAN_LIMITS.maxDurationMs;
  // A zero/negative concurrency would silently produce an empty scan.
  const concurrency = Math.max(1, options.limits?.concurrency ?? DEFAULT_SCAN_LIMITS.concurrency);
  const clock = options.now ?? Date.now;

  const rootPath = normalizePath(root);
  if (!rootPath) {
    throw new Error('Project scan root is required.');
  }

  const existing = new Set((options.existingPaths ?? []).map(normalizePath));
  const queue: QueueItem[] = [{ path: rootPath, order: 0 }];
  const seen = new Set([rootPath]);
  const active = new Map<string, Promise<ListOutcome>>();
  const found: QueueItem[] = [];
  let nextOrder = 1;
  let entries = 0;
  let skippedForPermission = 0;
  let truncated = false;
  let reason: ScanResult['reason'];

  const startedAt = clock();
  const stop = (next: NonNullable<ScanResult['reason']>) => {
    if (reason !== undefined) return;
    truncated = next !== 'cancelled';
    reason = next;
  };

  while (true) {
    // Checked once per round, before dispatching more listings.
    if (signal?.cancelled) {
      stop('cancelled');
    } else if (clock() - startedAt >= maxDurationMs) {
      stop('max-duration');
    }
    if (reason !== undefined) break;

    while (active.size < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const pending = listDirectory(item.path).then(
        (entriesRead): ListOutcome => ({ item, ok: true, entries: entriesRead }),
        (error: unknown): ListOutcome => ({ item, ok: false, error }),
      );
      active.set(item.path, pending);
    }

    if (active.size === 0) break;

    const outcome = await Promise.race(Array.from(active.values()));
    active.delete(outcome.item.path);

    if (!outcome.ok) {
      // Only the root (order 0) surfaces its failure to the caller.
      if (outcome.item.order === 0) throw outcome.error;
      skippedForPermission += 1;
      continue;
    }

    let hasMarker = false;
    let hitEntryLimit = false;
    const subdirectories: string[] = [];

    for (const entry of outcome.entries) {
      entries += 1;
      if (entry.type === 'directory') {
        if (entry.name === '.opencode') {
          hasMarker = true;
        } else if (!PRUNED_DIRECTORY_SET.has(entry.name)) {
          subdirectories.push(entry.name);
        }
      }
      // The entry that reaches the cap is still applied; everything after it
      // in this response is left unread.
      if (entries >= maxEntries) {
        hitEntryLimit = true;
        break;
      }
    }

    if (hasMarker) {
      found.push(outcome.item);
    } else if (!hitEntryLimit) {
      // A matched project is a leaf for discovery purposes: no descendants.
      for (const name of subdirectories) {
        const childPath = joinPath(outcome.item.path, name);
        if (seen.has(childPath)) continue;
        seen.add(childPath);
        queue.push({ path: childPath, order: nextOrder });
        nextOrder += 1;
      }
    }

    if (hitEntryLimit) {
      stop('max-entries');
      break;
    }
  }

  found.sort((left, right) => left.order - right.order);

  return {
    candidates: found.map((candidate) => ({
      path: candidate.path,
      exists: existing.has(candidate.path),
    })),
    truncated,
    skippedForPermission,
    reason,
  };
}
