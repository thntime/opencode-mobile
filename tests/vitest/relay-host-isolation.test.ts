import { describe, expect, it, vi } from 'vitest';

import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

// The relay mounts each host behind its own path, so the canonical connection
// identity (server URL + user) is what separates one host's data from another.
const scopes = await loadTs('lib/connection-scope.ts', {
  'base-64': { encode: (value: string) => Buffer.from(value, 'binary').toString('base64') },
});

const hostA = { serverUrl: 'https://relay.example.test/relay/host-a', username: 'alice', password: 'secret-a' };
const hostB = { serverUrl: 'https://relay.example.test/relay/host-b', username: 'alice', password: 'secret-b' };

async function mountSessionCaches(identity: { serverUrl: string; username: string; password: string }) {
  const runtime = hookRuntime();
  const reset = await loadTs('providers/use-connection-scope-reset.ts', { react: runtime.react });
  const cache = await loadTs('providers/session-scope-cache.ts', {
    react: runtime.react,
    '@/lib/connection-scope': scopes,
    '@/providers/use-connection-scope-reset': reset,
  });
  runtime.mount(({ identity }: { identity: typeof hostA }) => cache.useSessionScopeCaches(identity), { identity });
  return { runtime, cache };
}

describe('relay host isolation', () => {
  it('keeps colliding session ids on the host that produced them', async () => {
    const { runtime } = await mountSessionCaches(hostA);

    runtime.value.setMessagesBySession({ shared: ['host-a:hello'] });
    runtime.value.setDiffsBySession({ shared: ['host-a:diff'] });
    runtime.value.setTodosBySession({ shared: ['host-a:todo'] });
    runtime.flush();
    expect(runtime.value.messagesBySession).toEqual({ shared: ['host-a:hello'] });

    // Switching hosts must drop everything keyed only by a session id: the new
    // host can legitimately answer `shared` with a completely different chat.
    runtime.update({ identity: hostB });
    expect(runtime.value.messagesBySession).toEqual({});
    expect(runtime.value.diffsBySession).toEqual({});
    expect(runtime.value.todosBySession).toEqual({});

    runtime.value.setMessagesBySession({ shared: ['host-b:hello'] });
    runtime.value.setDiffsBySession({ shared: ['host-b:diff'] });
    runtime.value.setTodosBySession({ shared: ['host-b:todo'] });
    runtime.flush();
    expect(runtime.value.messagesBySession).toEqual({ shared: ['host-b:hello'] });

    // Back to the first host: the second host's transcript must not survive.
    runtime.update({ identity: hostA });
    expect(runtime.value.messagesBySession).toEqual({});
    expect(runtime.value.diffsBySession).toEqual({});
    expect(runtime.value.todosBySession).toEqual({});

    runtime.value.setMessagesBySession({ shared: ['host-a:refetched'] });
    runtime.flush();
    expect(runtime.value.messagesBySession).toEqual({ shared: ['host-a:refetched'] });
    runtime.unmount();
  });

  it('keeps session caches across a reconnect of the same host', async () => {
    const { runtime } = await mountSessionCaches(hostA);
    runtime.value.setMessagesBySession({ shared: ['host-a:hello'] });
    runtime.flush();

    // A credential rotation or retry keeps the identity, so the data is still
    // valid and must not flash away.
    runtime.update({ identity: { ...hostA, password: 'rotated' } });
    expect(runtime.value.messagesBySession).toEqual({ shared: ['host-a:hello'] });

    // A trailing slash is normalized away by the canonical scope helper.
    runtime.update({ identity: { ...hostA, serverUrl: `${hostA.serverUrl}/` } });
    expect(runtime.value.messagesBySession).toEqual({ shared: ['host-a:hello'] });
    runtime.unmount();
  });

  it('reports a scope change only when the canonical identity changes', async () => {
    const { sessionScopeChanged } = await loadTs('providers/session-scope-cache.ts', {
      react: { useState: (initial: unknown) => [initial, () => {}] },
      '@/lib/connection-scope': scopes,
      '@/providers/use-connection-scope-reset': { useConnectionScopeReset: () => ({ current: '' }) },
    });
    const scopeA = scopes.getConnectionScope(hostA);
    expect(sessionScopeChanged(scopeA, hostB)).toBe(true);
    expect(sessionScopeChanged(scopeA, { ...hostA, password: 'rotated' })).toBe(false);
    expect(sessionScopeChanged(scopeA, { ...hostA, serverUrl: `${hostA.serverUrl}/` })).toBe(false);
  });

  it('resets terminals, commands and the event buffer once per host change', async () => {
    const runtime = hookRuntime();
    const { useConnectionScopeReset } = await loadTs('providers/use-connection-scope-reset.ts', { react: runtime.react });
    const onScopeChange = vi.fn();
    runtime.mount(useConnectionScopeReset, { scope: 'host-a', onScopeChange });
    expect(onScopeChange).not.toHaveBeenCalled();

    runtime.update({ scope: 'host-a' });
    expect(onScopeChange).not.toHaveBeenCalled();

    runtime.update({ scope: 'host-b' });
    expect(onScopeChange).toHaveBeenCalledTimes(1);

    runtime.update({ scope: 'host-b' });
    expect(onScopeChange).toHaveBeenCalledTimes(1);

    runtime.update({ scope: 'host-a' });
    expect(onScopeChange).toHaveBeenCalledTimes(2);
    runtime.unmount();
  });

  it('never replays the previous host event to a new subscriber after a reset', async () => {
    const { createSharedEventStream } = await loadTs('providers/shared-event-stream.ts', {
      '@/lib/opencode/events': {},
      '@/providers/realtime-timing': { SSE_STALENESS_MS: 90000, WATCHDOG_TICK_MS: 7000 },
    });
    let opens = 0;
    let release!: () => void;
    const subscribe = createSharedEventStream(async function* (_client: unknown, signal: AbortSignal) {
      opens += 1;
      const host = opens;
      const stopped = new Promise<void>((resolve) => { release = resolve; });
      signal.addEventListener('abort', () => release());
      yield { type: 'connected', host };
      await stopped;
    });

    const first = subscribe({}, new AbortController().signal);
    expect((await first.next()).value).toEqual({ type: 'connected', host: 1 });

    subscribe.reset();
    expect((await first.next()).done).toBe(true);

    // A subscriber arriving right after the switch must open the new host's
    // transport instead of inheriting the old host's buffered envelope.
    const second = subscribe({}, new AbortController().signal);
    expect((await second.next()).value).toEqual({ type: 'connected', host: 2 });
    expect(opens).toBe(2);
  });
});
