import { useLayoutEffect, useRef } from 'react';

/**
 * Runs `onScopeChange` exactly when the canonical connection identity changes.
 *
 * Session-id-keyed caches, terminal transports, command catalogs and the event
 * stream only describe the connection that produced them. Reconnecting to the
 * same host (a credential rotation or a retry) must keep them, while pointing
 * the runtime at another server or relay host must drop them before the new
 * host can answer with an id the old host handed out.
 *
 * The returned ref always holds the scope the current data belongs to, so
 * imperative resets can decide whether they are crossing a connection boundary.
 */
export function useConnectionScopeReset({ scope, onScopeChange }: { scope: string; onScopeChange: () => void }) {
  const previous = useRef(scope);
  useLayoutEffect(() => {
    if (previous.current === scope) return;
    previous.current = scope;
    onScopeChange();
  }, [onScopeChange, scope]);
  return previous;
}
