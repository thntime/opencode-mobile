import { describe, expect, it, vi } from 'vitest';

import { hookRuntime, loadTs } from '../helpers/runtime.mjs';

// The realtime hook owns the reconnect loop, so auth recovery is asserted on
// the loop itself: a recovered refresh must rebuild the stream, a failed one
// must stop and report the fatal kind.
const appState = {
  currentState: 'active' as string,
  addEventListener: () => ({ remove: () => undefined }),
};

function stream(behaviour: 'throw' | 'yield' | 'forbidden') {
  return async function* () {
    if (behaviour === 'throw') throw new Error('401 Unauthorized');
    if (behaviour === 'forbidden') throw new Error('Relay 拒绝了该账号的访问（403）');
    yield { type: 'ready', location: { directory: '/repo' } };
    await new Promise(() => undefined);
  };
}

async function mountRealtime(onFatalError: () => Promise<boolean>, subscribe: () => AsyncIterable<unknown>) {
  const runtime = hookRuntime();
  const hook = await loadTs('providers/use-opencode-realtime.ts', {
    react: runtime.react,
    'react-native': { AppState: appState },
    '@/lib/opencode/events': { subscribeEvents: subscribe },
    '@/lib/opencode/client/errors': {
      classifyConnectionFailure: (error: { message?: string }) => {
        const message = error?.message ?? '';
        if (/Relay 拒绝了该账号的访问|\b403\b/.test(message)) return 'forbidden';
        return /401|unauthorized/i.test(message) ? 'auth' : 'unknown';
      },
      isAuthConnectionFailure: (kind: string) => kind === 'auth' || kind === 'entitlement',
    },
    '@/providers/realtime-timing': { SSE_STALENESS_MS: 60_000, SSE_FOREGROUND_CYCLE_MS: 60_000, WATCHDOG_TICK_MS: 60_000 },
  }, runtime.globals);

  const value = runtime.mount(hook.useOpencodeRealtime, {
    catalogClient: { __opencode: {} },
    activeProjectPath: '/repo',
    connected: true,
    busy: false,
    onEvent: vi.fn(),
    onGlobalEvent: vi.fn(),
    onFatalError,
    refreshSessions: async () => undefined,
    refreshPendingInteractions: async () => undefined,
    refreshMessages: async () => undefined,
    refreshSessionDiff: async () => undefined,
    refreshSessionTodos: async () => undefined,
    subscribe,
  });
  return { runtime, value };
}

describe('relay realtime auth recovery', () => {
  it('rebuilds the event stream after a successful refresh', async () => {
    const calls: string[] = [];
    const subscribe = () => {
      const behaviour = calls.length === 0 ? 'throw' : 'yield';
      calls.push(behaviour);
      return stream(behaviour)();
    };
    const onFatalError = vi.fn(async () => true);
    const { runtime } = await mountRealtime(onFatalError, subscribe);

    await runtime.settle();

    expect(onFatalError).toHaveBeenCalledWith('auth');
    expect(calls).toEqual(['throw', 'yield']);
    expect(runtime.value.eventStreamStatus).toBe('connected');
    runtime.unmount();
  });

  it('stops the loop and marks the session for reauthentication when refresh fails', async () => {
    const calls: string[] = [];
    const subscribe = () => {
      calls.push('attempt');
      return stream('throw')();
    };
    const onFatalError = vi.fn(async () => false);
    const { runtime } = await mountRealtime(onFatalError, subscribe);

    await runtime.settle();

    expect(onFatalError).toHaveBeenCalledWith('auth');
    expect(calls).toEqual(['attempt']);
    expect(runtime.value.eventStreamStatus).toBe('error');
    runtime.unmount();
  });

  // I5: a Relay 403 cannot heal by retrying (the token is not the problem), so
  // the loop must stop and surface the fatal kind instead of reconnecting every
  // 15s. The provider decides whether the selected host survives.
  it('stops the loop on a Relay 403 instead of retrying forever', async () => {
    const calls: string[] = [];
    const subscribe = () => {
      calls.push('attempt');
      return stream('forbidden')();
    };
    const onFatalError = vi.fn(async () => false);
    const { runtime } = await mountRealtime(onFatalError, subscribe);

    await runtime.settle();

    expect(onFatalError).toHaveBeenCalledWith('forbidden');
    expect(calls).toEqual(['attempt']);
    expect(runtime.value.eventStreamStatus).toBe('error');
    runtime.unmount();
  });
});
