// Breadth-first discovery of projects on a remote filesystem.
//
// A directory is a project when one of its direct children is an `.opencode`
// directory. Traversal is kept free of network and platform APIs: the caller
// injects `listDirectory`, so the scan can be unit tested with a fake tree and
// the real implementation only maps `file.list` onto that interface.
//
// Limits are deliberate: the entry cap bounds the work, the duration cap bounds
// the worst-case wait (including in-flight requests), the depth cap guards
// against symlink loops, and the concurrency cap bounds the burst on the tunnel.
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
  failedReads: number;
  reason?: 'max-entries' | 'max-duration' | 'cancelled';
};

export const DEFAULT_SCAN_LIMITS: Required<ScanLimits> = {
  maxEntries: 2000,
  maxDurationMs: 15000,
  concurrency: 4,
};

// Deep enough for real repositories, shallow enough that a symlink loop cannot
// keep the queue growing. Depth is counted from the scan root (root = 0).
export const SCAN_DEPTH_LIMIT = 8;

// How often an in-flight round re-checks cancellation and the deadline. The
// `file.list` call itself cannot be aborted, so this bounds how long the scan
// can wait on a slow request before returning.
export const SCAN_CANCEL_POLL_MS = 100;

// Directories that never contain a project worth discovering but can hold huge
// trees. `build`, `dist`, `vendor`, and `target` are deliberately absent: those
// names are common for real project roots and must stay discoverable.
export const PRUNED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
];

const PRUNED_DIRECTORY_SET = new Set(PRUNED_DIRECTORIES);

type QueueItem = { path: string; depth: number };

type ListOutcome =
  | { item: QueueItem; ok: true; entries: DirectoryEntry[] }
  | { item: QueueItem; ok: false; error: unknown };

/**
 * Canonical form for remote POSIX paths used by both the scanner and the
 * provider-facing service: trimmed, duplicate slashes collapsed, and no
 * trailing slash except for the filesystem root.
 */
export function normalizeScanPath(value: string): string {
  const collapsed = value.trim().replace(/\/{2,}/g, '/');
  if (!collapsed) return '';
  if (/^\/+$/.test(collapsed)) return '/';
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** Parent of a remote POSIX path; empty when the path has no parent. */
export function parentScanPath(value: string): string {
  const path = normalizeScanPath(value);
  if (!path || path === '/') return '';
  const index = path.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : path.slice(0, index);
}

/** Joins with `/` (the server is POSIX); no platform path API is involved. */
function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const record = recordOf(error);
  const status = record?.status ?? recordOf(record?.response)?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  const record = recordOf(error);
  for (const source of [record, recordOf(record?.cause)]) {
    // `errno` carries the transport's EACCES even when the wrapper's `code` is
    // a scan-specific label, so it wins when both are present.
    const errno = source?.errno;
    if (typeof errno === 'string') return errno;
    const code = source?.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Only explicit authorization failures count as "skipped for permission". */
function isPermissionError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403 || errorCode(error) === 'EACCES';
}

/** The server may echo separators or dot entries; never trust them as names. */
function entryName(entry: DirectoryEntry): string {
  return typeof entry.name === 'string' ? entry.name.replace(/\/+$/, '') : '';
}

function isValidEntryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/');
}

/**
 * Scans `root` breadth-first for directories that directly contain an
 * `.opencode` directory.
 *
 * Candidates are sorted by path so the UI order never depends on which
 * concurrent listing happened to finish first. A root listing failure is
 * rethrown (the UI needs to tell the user the root is inaccessible); failures
 * below the root are classified as permission skips or failed reads.
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

  const rootPath = normalizeScanPath(root);
  if (!rootPath) {
    throw new Error('Project scan root is required.');
  }

  const existing = new Set((options.existingPaths ?? []).map(normalizeScanPath));
  const queue: QueueItem[] = [{ path: rootPath, depth: 0 }];
  const seen = new Set([rootPath]);
  const active = new Map<string, Promise<ListOutcome>>();
  const found: string[] = [];
  let entries = 0;
  let skippedForPermission = 0;
  let failedReads = 0;
  let truncated = false;
  let reason: ScanResult['reason'];

  const startedAt = clock();
  const stop = (next: NonNullable<ScanResult['reason']>) => {
    if (reason !== undefined) return;
    reason = next;
    // A partial failure already marks the result incomplete; cancelling later
    // must not erase that signal.
    if (next !== 'cancelled') truncated = true;
  };

  // Waits for the next listing, but never longer than the remaining duration.
  // Cancellation is polled so a hung request cannot keep the scan (and the UI)
  // waiting until the transport gives up.
  const waitForOutcome = async (): Promise<{ outcome?: ListOutcome; stop?: 'cancelled' | 'max-duration' }> => {
    if (signal?.cancelled) return { stop: 'cancelled' };
    const remaining = startedAt + maxDurationMs - clock();
    if (remaining <= 0) return { stop: 'max-duration' };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = new Promise<{ polled: true }>((resolve) => {
      timer = setTimeout(() => resolve({ polled: true }), Math.min(remaining, SCAN_CANCEL_POLL_MS));
    });
    try {
      const winner = await Promise.race([
        ...Array.from(active.values()).map((pending) => pending.then((outcome) => ({ outcome }))),
        poll,
      ]);
      return 'outcome' in winner ? { outcome: winner.outcome } : {};
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  while (true) {
    if (signal?.cancelled) {
      stop('cancelled');
      break;
    }
    if (clock() - startedAt >= maxDurationMs) {
      stop('max-duration');
      break;
    }

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

    const waited = await waitForOutcome();
    if (waited.stop) {
      stop(waited.stop);
      break;
    }
    const outcome = waited.outcome;
    if (!outcome) continue; // Poll tick: re-check cancellation and the deadline.
    active.delete(outcome.item.path);

    if (!outcome.ok) {
      // Only the root surfaces its failure to the caller.
      if (outcome.item.depth === 0) throw outcome.error;
      if (isPermissionError(outcome.error)) {
        skippedForPermission += 1;
      } else {
        failedReads += 1;
        truncated = true;
      }
      continue;
    }

    let hasMarker = false;
    let unreadEntries = false;
    const subdirectories: string[] = [];

    for (let index = 0; index < outcome.entries.length; index += 1) {
      if (entries >= maxEntries) {
        // There are entries left in this response that will never be applied.
        unreadEntries = true;
        break;
      }
      const name = entryName(outcome.entries[index]);
      entries += 1;
      if (!isValidEntryName(name)) continue;
      if (outcome.entries[index].type !== 'directory') continue;
      if (name === '.opencode') {
        hasMarker = true;
      } else if (!PRUNED_DIRECTORY_SET.has(name)) {
        subdirectories.push(name);
      }
    }

    if (hasMarker) found.push(outcome.item.path);

    if (entries >= maxEntries) {
      // Reaching the cap exactly on the last entry is a complete result; only
      // pending work (unread entries, queued directories, or in-flight reads)
      // makes it truncated.
      if (unreadEntries || queue.length > 0 || active.size > 0) stop('max-entries');
      break;
    }

    // A matched project is a leaf for discovery purposes: no descendants. The
    // root is the exception — the user picked it as the scan scope, so a marker
    // there must not hide every project beneath it.
    if (!hasMarker || outcome.item.depth === 0) {
      for (const name of subdirectories) {
        const childPath = joinPath(outcome.item.path, name);
        if (seen.has(childPath)) continue;
        seen.add(childPath);
        if (outcome.item.depth + 1 > SCAN_DEPTH_LIMIT) {
          truncated = true;
          continue;
        }
        queue.push({ path: childPath, depth: outcome.item.depth + 1 });
      }
    }
  }

  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    candidates: found.map((path) => ({
      path,
      exists: existing.has(path),
    })),
    truncated,
    skippedForPermission,
    failedReads,
    reason,
  };
}
