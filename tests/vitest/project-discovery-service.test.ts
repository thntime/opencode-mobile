import { describe, expect, it, vi } from 'vitest';

import { scanForProjects } from '@/lib/project-discovery';
import {
  buildScanListDirectory,
  resolveScanRoot,
  ScanError,
  type ScanErrorCode,
} from '@/providers/services/project-discovery-service';

function v2Client(list: ReturnType<typeof vi.fn>) {
  return { api: { file: { list } }, __opencode: { contract: 'v2', directory: '/repo' } } as never;
}

function v1Client(list: ReturnType<typeof vi.fn>) {
  return { compatibility: { file: { list } }, __opencode: { contract: 'v1', directory: '/repo' } } as never;
}

function scanError(fn: () => unknown, code: ScanErrorCode) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe(code);
    return error as ScanError;
  }
  throw new Error(`expected a ScanError with code ${code}`);
}

describe('project discovery service', () => {
  it('lists V2 directories against the scanned root and strips trailing slashes', async () => {
    const list = vi.fn(async () => ({ data: [{ path: 'src/', type: 'directory' }, { path: 'a.ts', type: 'file' }] }));
    const client = v2Client(list);

    expect(resolveScanRoot(client, '/work//demo/')).toBe('/work/demo');
    await expect(buildScanListDirectory(client)('/work//demo/')).resolves.toEqual([
      { name: 'src', type: 'directory' },
      { name: 'a.ts', type: 'file' },
    ]);
    expect(list).toHaveBeenCalledWith({ location: { directory: '/work/demo' }, path: '.' });
  });

  it('surfaces the upstream status and errno on a typed read failure', async () => {
    const list = vi.fn(async () => { throw Object.assign(new Error('denied'), { status: 403, code: 'EACCES' }); });

    await expect(buildScanListDirectory(v2Client(list))('/root')).rejects.toMatchObject({
      code: 'scan_directory_unreadable',
      status: 403,
      errno: 'EACCES',
    });
  });

  it('treats a missing V2 payload as a failed read but accepts an empty directory', async () => {
    const missing = vi.fn(async () => ({}));
    await expect(buildScanListDirectory(v2Client(missing))('/root')).rejects.toMatchObject({
      code: 'scan_directory_unreadable',
    });

    const empty = vi.fn(async () => ({ data: [] }));
    await expect(buildScanListDirectory(v2Client(empty))('/root')).resolves.toEqual([]);
  });

  it('scopes V1 listings to the current project with a relative path', async () => {
    const list = vi.fn(async () => ({
      data: [
        { name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false },
        { name: 'a.ts', path: 'src/a.ts', absolute: '/repo/src/a.ts', type: 'file', ignored: false },
      ],
    }));
    const client = v1Client(list);
    const scan = buildScanListDirectory(client);

    expect(resolveScanRoot(client, '/repo/src/')).toBe('/repo/src');
    await expect(scan('/repo/src/')).resolves.toEqual([
      { name: 'src', type: 'directory' },
      { name: 'a.ts', type: 'file' },
    ]);
    expect(list).toHaveBeenCalledWith({ path: 'src' });

    await scan('/repo');
    expect(list).toHaveBeenLastCalledWith({ path: '' });
  });

  it('falls back to the final path segment when a V1 entry has no name', async () => {
    const list = vi.fn(async () => ({
      data: [{ path: 'src/deep', type: 'directory' }],
    }));

    await expect(buildScanListDirectory(v1Client(list))('/repo')).resolves.toEqual([
      { name: 'deep', type: 'directory' },
    ]);
  });

  it('rejects V1 roots outside the current project with a typed error code', () => {
    const list = vi.fn();
    const client = v1Client(list);

    scanError(() => resolveScanRoot(client, '/repo-other/src'), 'scan_scope_v1');
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects V1 scans when the connection has no project scope', () => {
    const client = { compatibility: { file: { list: vi.fn() } }, __opencode: { contract: 'v1' } } as never;

    scanError(() => resolveScanRoot(client, '/repo'), 'scan_scope_v1');
  });

  it('requires an absolute, non-empty scan root with typed codes', () => {
    const client = v2Client(vi.fn());

    scanError(() => resolveScanRoot(client, '   '), 'scan_root_required');
    scanError(() => resolveScanRoot(client, 'repo/src'), 'scan_root_relative');
    expect(resolveScanRoot(client, '/')).toBe('/');
  });

  it('runs the real scanner against a fake V2 file API', async () => {
    const tree: Record<string, { path: string; type: 'file' | 'directory' }[]> = {
      '/work': [
        { path: 'app/', type: 'directory' },
        { path: 'build/', type: 'directory' },
        { path: 'lib/', type: 'directory' },
        { path: 'node_modules/', type: 'directory' },
        { path: 'notes.txt', type: 'file' },
      ],
      '/work/app': [{ path: '.opencode/', type: 'directory' }],
      '/work/build': [{ path: '.opencode/', type: 'directory' }],
      '/work/lib': [{ path: '.opencode/', type: 'directory' }],
      '/work/node_modules': [{ path: '.opencode/', type: 'directory' }],
    };
    const list = vi.fn(async ({ location }: { location: { directory: string } }) => {
      const entries = tree[location.directory];
      if (!entries) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: entries };
    });

    const result = await scanForProjects({
      root: '/work',
      listDirectory: buildScanListDirectory(v2Client(list)),
      existingPaths: ['/work/app/'],
    });

    expect(result.candidates).toEqual([
      { path: '/work/app', exists: true },
      { path: '/work/build', exists: false },
      { path: '/work/lib', exists: false },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.failedReads).toBe(0);
    expect(list).toHaveBeenCalledWith({ location: { directory: '/work' }, path: '.' });
    expect(list).not.toHaveBeenCalledWith({ location: { directory: '/work/node_modules' }, path: '.' });
  });

  it('classifies a wrapped EACCES as a permission skip', async () => {
    const list = vi.fn(async ({ location }: { location: { directory: string } }) => {
      if (location.directory === '/work/denied') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return { data: location.directory === '/work' ? [
        { path: 'denied/', type: 'directory' },
        { path: 'good/', type: 'directory' },
      ] : [{ path: '.opencode/', type: 'directory' }] };
    });

    const result = await scanForProjects({
      root: '/work',
      listDirectory: buildScanListDirectory(v2Client(list)),
      limits: { concurrency: 1 },
    });

    expect(result.skippedForPermission).toBe(1);
    expect(result.failedReads).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('classifies a V1 SDK wrapper status from the cause chain', async () => {
    const list = vi.fn(async () => {
      throw new Error('forbidden', { cause: { status: 403, body: { message: 'denied' } } });
    });

    await expect(buildScanListDirectory(v1Client(list))('/repo')).rejects.toMatchObject({
      code: 'scan_directory_unreadable',
      status: 403,
    });
  });

  it('classifies V1 cause-chain permission failures for the root and subdirectories', async () => {
    const denied = () => {
      throw new Error('forbidden', { cause: { status: 403, body: { message: 'denied' } } });
    };
    const rootList = vi.fn(async () => denied());
    const rootFailure = await scanForProjects({
      root: '/repo',
      listDirectory: buildScanListDirectory(v1Client(rootList)),
    }).catch((error: unknown) => error);
    expect(rootFailure).toMatchObject({ code: 'scan_directory_unreadable', status: 403 });

    const list = vi.fn(async ({ path }: { path: string }) => {
      if (path === 'denied') denied();
      return {
        data: path === ''
          ? [{ name: 'denied', path: 'denied', type: 'directory' }, { name: 'good', path: 'good', type: 'directory' }]
          : [{ name: '.opencode', path: '.opencode', type: 'directory' }],
      };
    });
    const result = await scanForProjects({
      root: '/repo',
      listDirectory: buildScanListDirectory(v1Client(list)),
      limits: { concurrency: 1 },
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/repo/good']);
    expect(result.skippedForPermission).toBe(1);
    expect(result.failedReads).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('classifies a V1 cause-chain EACCES as a permission skip', async () => {
    const list = vi.fn(async ({ path }: { path: string }) => {
      if (path === 'denied') throw new Error('denied', { cause: { code: 'EACCES' } });
      return {
        data: path === ''
          ? [{ name: 'denied', path: 'denied', type: 'directory' }, { name: 'good', path: 'good', type: 'directory' }]
          : [{ name: '.opencode', path: '.opencode', type: 'directory' }],
      };
    });
    const result = await scanForProjects({
      root: '/repo',
      listDirectory: buildScanListDirectory(v1Client(list)),
      limits: { concurrency: 1 },
    });

    expect(result.skippedForPermission).toBe(1);
    expect(result.failedReads).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('classifies real service read failures by HTTP status', async () => {
    const list = vi.fn(async ({ location }: { location: { directory: string } }) => {
      if (location.directory === '/work/denied') throw Object.assign(new Error('denied'), { status: 403 });
      if (location.directory === '/work/missing') throw Object.assign(new Error('missing'), { status: 404 });
      return { data: location.directory === '/work' ? [
        { path: 'denied/', type: 'directory' },
        { path: 'missing/', type: 'directory' },
        { path: 'good/', type: 'directory' },
      ] : [{ path: '.opencode/', type: 'directory' }] };
    });
    const result = await scanForProjects({
      root: '/work',
      listDirectory: buildScanListDirectory(v2Client(list)),
      limits: { concurrency: 1 },
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(['/work/good']);
    expect(result.skippedForPermission).toBe(1);
    expect(result.failedReads).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
