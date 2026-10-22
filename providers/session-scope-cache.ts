import { useCallback, useState } from 'react';

import { getConnectionScope, type ConnectionIdentity } from '@/lib/connection-scope';
import type { SessionMessageRecord } from '@/lib/opencode/format';
import type { FileDiff, Todo } from '@/lib/opencode/types';
import { useConnectionScopeReset } from '@/providers/use-connection-scope-reset';

/**
 * The provider caches that are keyed by session id alone.
 *
 * Session ids are only unique inside one server (and one relay host), so these
 * maps must never survive a connection change: the next host may hand out the
 * same id for an unrelated chat.
 */
export function useSessionScopeCaches(identity: ConnectionIdentity) {
  const [messagesBySession, setMessagesBySession] = useState<Record<string, SessionMessageRecord[]>>({});
  const [diffsBySession, setDiffsBySession] = useState<Record<string, FileDiff[]>>({});
  const [todosBySession, setTodosBySession] = useState<Record<string, Todo[]>>({});
  const clearSessionCaches = useCallback(() => {
    setMessagesBySession({});
    setDiffsBySession({});
    setTodosBySession({});
  }, []);
  const sessionScopeRef = useConnectionScopeReset({
    scope: getConnectionScope(identity),
    onScopeChange: clearSessionCaches,
  });
  return {
    messagesBySession, setMessagesBySession,
    diffsBySession, setDiffsBySession,
    todosBySession, setTodosBySession,
    clearSessionCaches, sessionScopeRef,
  };
}

/**
 * True when `next` is a different connection (another server or relay host)
 * than the one the current session caches were built from.
 */
export function sessionScopeChanged(previousScope: string, next: ConnectionIdentity): boolean {
  return previousScope !== getConnectionScope(next);
}
