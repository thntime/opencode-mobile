import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_LIMITS,
  PRUNED_DIRECTORIES,
  scanForProjects,
  type DirectoryEntry,
  type ListDirectory,
} from '@/lib/project-discovery';

const dirs = (...names: string[]): DirectoryEntry[] =>
  names.map((name) => ({ name, type: 'directory' }));

const files = (...names: string[]): DirectoryEntry[] =>
  names.map((name) => ({ name, type: 'file' }));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeTree(tree: Record<string, DirectoryEntry[]>) {
  const calls: string[] = [];
  const listDirectory: ListDirectory = async (path) => {
    calls.push(path);
    const entries = tree[path];
    if (!entries) throw new Error(`ENOENT: no such directory, ${path}`);
    return entries;
  };
  return { listDirectory, calls };
}

function deferredTree(tree: Record<string, DirectoryEntry[]>) {
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  const listDirectory: ListDirectory = (path) =>
    new Promise((resolve) => {
      calls.push(path);
      gates.set(path, () => resolve(tree[path] ?? []));
    });
  const release = (path: string) => {
    const gate = gates.get(path);
    if (!gate) throw new Error(`no pending listing for ${path}`);
    gates.delete(path);
    gate();
  };
  return { listDirectory, calls, release };
}

describe('scanForProjects', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_SCAN_LIMITS).toEqual({ maxEntries: 2000, maxDurationMs: 15000, concurrency: 4 });
    expect(PRUNED_DIRECTORIES).toContain('node_modules');
    expect(PRUNED_DIRECTORIES).toContain('__pycache__');
  });

  it('identifies a directory that directly contains an .opencode directory', async () => {
    const { listDirectory, calls } = fakeTree({
      '/root': dirs('app', 'docs'),
      '/root/app': dirs('.opencode', 'src'),
      '/root/app/src': dirs('.opencode'),
      '/root/docs': files('readme.md'),
    });

    const result = await scanForProjects({ root: '/root', listDirectory });

    expect(result.candidates).toEqual([{ path: '/root/app', exists: false }]);
    expect(result.truncated).toBe(false);
    expect(result.skippedForPermission).toBe(0);
    expect(result.reason).toBeUndefined();
    // The match is not descended into: `src` would also match.
    expect(calls).not.toContain('/root/app/src');
  });

  it('keeps descending through directories without the marker', async () => {
    const { listDirectory, calls } = fakeTree({
      '/root': dirs('a'),
      '/root/a': dirs('b'),
      '/root/a/b': dirs('.opencode'),
    });

    const result = await scanForProjects({ root: '/root', listDirectory });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root/a/b']);
    expect(calls).toContain('/root/a');
    expect(calls).toContain('/root/a/b');
  });

  it('does not descend into a matched project', async () => {
    const { listDirectory, calls } = fakeTree({
      '/root': dirs('.opencode', 'nested'),
      '/root/nested': dirs('.opencode'),
    });

    const result = await scanForProjects({ root: '/root', listDirectory });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root']);
    expect(calls).toEqual(['/root']);
  });

  it('does not treat an .opencode file as a marker', async () => {
    const { listDirectory } = fakeTree({
      '/root': [...dirs('app'), ...files('.opencode')],
      '/root/app': dirs('.opencode'),
    });

    const result = await scanForProjects({ root: '/root', listDirectory });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root/app']);
  });

  it('does not enter pruned directories', async () => {
    const tree: Record<string, DirectoryEntry[]> = {
      '/root': dirs(...PRUNED_DIRECTORIES, 'project'),
      '/root/project': dirs('.opencode'),
    };
    for (const name of PRUNED_DIRECTORIES) {
      tree[`/root/${name}`] = dirs('.opencode');
    }
    const { listDirectory, calls } = fakeTree(tree);

    const result = await scanForProjects({ root: '/root', listDirectory });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root/project']);
    for (const name of PRUNED_DIRECTORIES) {
      expect(calls).not.toContain(`/root/${name}`);
    }
  });

  it('stops at the entry limit and reports truncation', async () => {
    const { listDirectory, calls } = fakeTree({
      '/root': dirs('.opencode', 'a', 'b'),
      '/root/a': dirs('.opencode'),
      '/root/b': dirs('.opencode'),
    });

    const result = await scanForProjects({
      root: '/root',
      listDirectory,
      limits: { maxEntries: 2 },
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root']);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('max-entries');
    expect(calls).toEqual(['/root']);
  });

  it('stops at the duration limit using the injected clock', async () => {
    let clock = 0;
    const { listDirectory: base, calls } = fakeTree({
      '/root': dirs('a'),
      '/root/a': dirs('b'),
      '/root/b': dirs('.opencode'),
    });
    const listDirectory: ListDirectory = async (path) => {
      clock += 60;
      return base(path);
    };

    const result = await scanForProjects({
      root: '/root',
      listDirectory,
      limits: { maxDurationMs: 100 },
      now: () => clock,
    });

    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('max-duration');
    expect(calls).toEqual(['/root', '/root/a']);
  });

  it('returns immediately when already cancelled', async () => {
    const { listDirectory, calls } = fakeTree({ '/root': dirs('.opencode') });

    const result = await scanForProjects({
      root: '/root',
      listDirectory,
      signal: { cancelled: true },
    });

    expect(result).toEqual({
      candidates: [],
      truncated: false,
      skippedForPermission: 0,
      reason: 'cancelled',
    });
    expect(calls).toEqual([]);
  });

  it('stops dispatching after cancellation and keeps what was found', async () => {
    const signal = { cancelled: false };
    const { listDirectory: base, calls } = fakeTree({
      '/root': dirs('a', 'b'),
      '/root/a': dirs('.opencode'),
      '/root/b': dirs('.opencode'),
    });
    const listDirectory: ListDirectory = async (path) => {
      const entries = await base(path);
      if (path === '/root/a') signal.cancelled = true;
      return entries;
    };

    const result = await scanForProjects({
      root: '/root',
      listDirectory,
      limits: { concurrency: 1 },
      signal,
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root/a']);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(calls).toEqual(['/root', '/root/a']);
  });

  it('counts unreadable subdirectories and keeps scanning', async () => {
    const { listDirectory, calls } = fakeTree({
      '/root': dirs('bad', 'good'),
      '/root/good': dirs('.opencode'),
    });

    const result = await scanForProjects({
      root: '/root',
      listDirectory,
      limits: { concurrency: 1 },
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/root/good']);
    expect(result.skippedForPermission).toBe(1);
    expect(result.truncated).toBe(false);
    expect(calls).toContain('/root/bad');
    expect(calls).toContain('/root/good');
  });

  it('rethrows when the root directory cannot be listed', async () => {
    const { listDirectory } = fakeTree({});

    await expect(scanForProjects({ root: '/missing', listDirectory })).rejects.toThrow('ENOENT');
  });

  it('marks candidates that already exist, ignoring trailing slashes', async () => {
    const { listDirectory } = fakeTree({
      '/root': dirs('a', 'b'),
      '/root/a': dirs('.opencode'),
      '/root/b': dirs('.opencode'),
    });

    const result = await scanForProjects({
      root: '/root/',
      listDirectory,
      existingPaths: ['/root/a/'],
    });

    expect(result.candidates).toEqual([
      { path: '/root/a', exists: true },
      { path: '/root/b', exists: false },
    ]);
  });

  it('never runs more than the configured number of listings at once', async () => {
    const { listDirectory, calls, release } = deferredTree({
      '/root': dirs('a', 'b', 'c'),
    });

    const scan = scanForProjects({
      root: '/root',
      listDirectory,
      limits: { concurrency: 2 },
    });
    await flush();
    expect(calls).toEqual(['/root']);

    release('/root');
    await flush();
    expect(calls).toEqual(['/root', '/root/a', '/root/b']);

    release('/root/a');
    await flush();
    expect(calls).toEqual(['/root', '/root/a', '/root/b', '/root/c']);

    release('/root/b');
    release('/root/c');
    const result = await scan;

    expect(result.truncated).toBe(false);
  });

  it('keeps BFS discovery order when responses arrive out of order', async () => {
    const { listDirectory, release } = deferredTree({
      '/root': dirs('a', 'b'),
      '/root/a': dirs('.opencode'),
      '/root/b': dirs('.opencode'),
    });

    const scan = scanForProjects({
      root: '/root',
      listDirectory,
      limits: { concurrency: 2 },
    });
    await flush();

    release('/root');
    await flush();
    release('/root/b');
    await flush();
    release('/root/a');

    const result = await scan;

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      '/root/a',
      '/root/b',
    ]);
  });
});
