import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeEvents } from '@/lib/opencode/events';
import { buildV2Client } from '@/lib/opencode/v2-client';
import { startFakeRelay, type FakeRelay } from './relay-fake-server';

// Proves whether the V2 event stream rides the injected `fetch` from
// `lib/opencode/v2/raw.ts` (createPrefixFetch -> fetchConnection) instead of a
// transport the SDK builds for itself. fetchConnection is the only place that
// calls `recordRequest`, so the usage counter is the observable side effect.
const counters = vi.hoisted(() => ({ recordBytes: vi.fn(), recordRequest: vi.fn() }));
vi.mock('@/lib/opencode/data-usage', () => counters);
vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('@/lib/opencode/client/types', () => ({
  defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096', username: '', password: '', directory: '' },
}));

let relay: FakeRelay;
let streamStack = '';

beforeAll(async () => {
  relay = await startFakeRelay();
});

afterAll(async () => {
  await relay.stop();
});

beforeEach(() => {
  counters.recordRequest.mockClear();
  counters.recordBytes.mockClear();
  streamStack = '';
  const transport = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/event')) streamStack = new Error('event stream fetch').stack ?? '';
    return transport(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V2 event stream transport', () => {
  it('sends the SSE request through the injected prefix fetch', async () => {
    const client = buildV2Client({ serverUrl: `${relay.url}/relay/abc`, username: 'relay-user', password: 'relay-pass', directory: '' });
    const controller = new AbortController();
    const events = subscribeEvents(client, controller.signal);

    const first = await events.next();
    controller.abort();
    await Promise.race([events.return(undefined), new Promise((resolve) => setTimeout(resolve, 1000))]);

    expect(first.done).toBe(false);
    expect(first.value.type).toBe('server.connected');

    const stream = relay.requests.find((request) => request.url.endsWith('/api/event'));
    expect(stream, 'the relay proxy should have received the SSE request').toBeDefined();
    // Evidence 1: the path prefix survives on the stream URL.
    expect(stream!.url).toBe('/relay/abc/api/event');
    // Evidence 2: the same Basic credential as every other request is attached.
    expect(stream!.authorization).toBe(`Basic ${Buffer.from('relay-user:relay-pass').toString('base64')}`);
    // Evidence 3: the request passed through fetchConnection (its usage counter ran),
    // and SSE bytes are not double-counted.
    expect(counters.recordRequest).toHaveBeenCalled();
    expect(counters.recordBytes).not.toHaveBeenCalled();
    // Evidence 4: the transport call stack originates in fetchConnection.
    expect(streamStack).toContain('fetchConnection');
  });
});
