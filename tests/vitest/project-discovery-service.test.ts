import { describe, expect, it, vi } from 'vitest';

import { buildScanListDirectory, resolveScanRoot } from '@/providers/services/project-discovery-service';

function v2Client(list: ReturnType<typeof vi.fn>) {
  return { api: { file: { list } }, __opencode: { contract: 'v2', directory: '/repo' } } as never;
}

function v1Client(list: ReturnType<typeof vi.fn>) {
  return { compatibility: { file: { list } }, __opencode: { contract: 'v1', directory: '/repo' } } as never;
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

  it('surfaces the upstream status when a V2 directory cannot be read', async () => {
    const list = vi.fn(async () => { throw Object.assign(new Error('denied'), { status: 403 }); });

    await expect(buildScanListDirectory(v2Client(list))('/root')).rejects.toThrow('Could not read directory: /root (HTTP 403)');
  });

  it('treats a missing V2 payload as a failed read but accepts an empty directory', async () => {
    const missing = vi.fn(async () => ({}));
    await expect(buildScanListDirectory(v2Client(missing))('/root')).rejects.toThrow('Could not read directory: /root');

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

  it('rejects V1 roots outside the current project instead of returning an empty scan', async () => {
    const list = vi.fn();
    const client = v1Client(list);

    expect(() => resolveScanRoot(client, '/repo-other/src')).toThrow('This connection can only scan directories inside the current project.');
    await expect(buildScanListDirectory(client)('/other')).rejects.toThrow('This connection can only scan directories inside the current project.');
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects V1 scans when the connection has no project scope', () => {
    const client = { compatibility: { file: { list: vi.fn() } }, __opencode: { contract: 'v1' } } as never;

    expect(() => resolveScanRoot(client, '/repo')).toThrow('This connection can only scan directories inside the current project.');
  });

  it('requires an absolute, non-empty scan root', () => {
    const client = v2Client(vi.fn());

    expect(() => resolveScanRoot(client, '   ')).toThrow('Enter a directory to scan.');
    expect(() => resolveScanRoot(client, 'repo/src')).toThrow('Scan root must be an absolute path.');
    expect(resolveScanRoot(client, '/')).toBe('/');
  });
});
