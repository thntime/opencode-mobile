import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { probeConnection } from '@/lib/opencode/client/probe';
import { startFakeRelay, type FakeRelay } from './relay-fake-server';

vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('@/lib/opencode/client/types', () => ({
  defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '', password: '', directory: '' },
}));

let relay: FakeRelay;

beforeAll(async () => {
  relay = await startFakeRelay();
});

afterAll(async () => {
  await relay.stop();
});

describe('relay-prefixed connection probe', () => {
  it('detects the V2 contract through the relay path prefix', async () => {
    const result = await probeConnection({ serverUrl: `${relay.url}/relay/abc`, username: '', password: '', directory: '' });

    expect(result).toEqual({ status: 'detected', contract: 'v2', version: '2.0.0-fake' });

    // Every probe request kept the prefix; the proxy would have answered 404 otherwise.
    const probed = relay.requests.map((request) => request.url);
    expect(probed).toContain('/relay/abc/api/info');
    expect(probed).toContain('/relay/abc/api/health');
    expect(probed).toContain('/relay/abc/global/health');
    expect(probed.every((url) => url.startsWith('/relay/abc/'))).toBe(true);
  });

  it('keeps the probe scoped to the relay prefix for an unknown host', async () => {
    const result = await probeConnection({ serverUrl: `${relay.url}/relay/missing`, username: '', password: '', directory: '' });

    expect(result.status).toBe('unknown');
    expect(relay.requests.filter((request) => request.url.startsWith('/relay/missing/'))).toHaveLength(3);
  });
});
