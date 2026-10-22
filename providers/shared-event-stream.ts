import { SSE_STALENESS_MS, WATCHDOG_TICK_MS } from '@/providers/realtime-timing';
import { subscribeEvents, type OpencodeEvent } from '@/lib/opencode/events';
import type { ScopedOpencodeClient } from '@/lib/opencode/client';

type Listener = { queue: OpencodeEvent[]; wake: () => void; heartbeat: () => void; error?: unknown; ended: boolean };
type Stream = { controller: AbortController; listeners: Set<Listener>; last?: OpencodeEvent };
export type SharedEventStream = ((client: ScopedOpencodeClient, signal: AbortSignal, heartbeat?: () => void) => AsyncGenerator<OpencodeEvent>) & {
  /** Drops the transport and its buffered envelope, e.g. when the runtime is
   *  pointed at another host and must not replay the previous host's events. */
  reset: () => void;
};
// A server has one transport even when several retained projects consume events.
export function createSharedEventStream(source = subscribeEvents): SharedEventStream {
  let stream: Stream | undefined;
  const subscribe = async function* subscribe(client: ScopedOpencodeClient, signal: AbortSignal, heartbeat: () => void = () => {}) {
    if (signal.aborted) return;
    const owned = stream ?? { controller: new AbortController(), listeners: new Set<Listener>() };
    const listener: Listener = { queue: owned.last ? [owned.last] : [], wake: () => {}, heartbeat, ended: false };
    owned.listeners.add(listener);
    const stop = () => { listener.ended = true; listener.wake(); };
    signal.addEventListener('abort', stop, { once: true });
    if (!stream) {
      stream = owned;
      void (async () => {
        let activityAt = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - activityAt >= SSE_STALENESS_MS) owned.controller.abort();
        }, WATCHDOG_TICK_MS);
        try {
          for await (const event of source(client, owned.controller.signal, () => {
            activityAt = Date.now();
            for (const item of owned.listeners) item.heartbeat();
          })) {
            if (!event) continue;
            activityAt = Date.now();
            owned.last = event;
            for (const item of owned.listeners) {
              if (item.queue.length >= 256) { item.error = new Error('Event consumer fell behind. Reconnecting.'); item.ended = true; }
              else item.queue.push(event);
              item.wake();
            }
          }
        } catch (error) { for (const item of owned.listeners) item.error = error; }
        finally {
          clearInterval(watchdog);
          for (const item of owned.listeners) { item.ended = true; item.wake(); }
          if (stream === owned) stream = undefined;
        }
      })();
    }
    try {
      while (!listener.ended || listener.queue.length) {
        if (signal.aborted) return;
        const next = listener.queue.shift();
        if (next) yield next;
        else await new Promise<void>((resolve) => { listener.wake = resolve; });
      }
      if (listener.error) throw listener.error;
    } finally {
      signal.removeEventListener('abort', stop);
      owned.listeners.delete(listener);
      if (!owned.listeners.size) { owned.controller.abort(); if (stream === owned) stream = undefined; }
    }
  };
  // Abort and forget the current transport before a new connection subscribes.
  // Listeners are detached without an error so consumers just end and let the
  // reconnect path open the new host's stream.
  const reset = () => {
    const owned = stream;
    stream = undefined;
    if (!owned) return;
    owned.controller.abort();
    for (const listener of owned.listeners) {
      listener.queue.length = 0;
      listener.error = undefined;
      listener.ended = true;
      listener.wake();
    }
  };
  return Object.assign(subscribe, { reset });
}
