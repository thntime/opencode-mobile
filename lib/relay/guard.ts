import type { RelayAuth } from './types';

// Pure routing decision for the relay flow, kept separate from `_layout.tsx`
// so the three startup states are unit-testable without mounting the router:
//   no relay block            -> undefined (direct/Cloud users, untouched)
//   relay block, no token     -> /relay-login
//   token, no hostId          -> /relay-hosts
//   token + hostId, locked    -> /relay-hosts (the passphrase is session-only)
//   token + hostId, unlocked  -> undefined (normal tabs)
export type RelayRouteTarget = '/relay-login' | '/relay-hosts' | undefined;

export function relayRouteTarget(relay: RelayAuth | undefined, hasToken: boolean, hostUnlocked = true, loginRequired = false): RelayRouteTarget {
  if (!relay) return undefined;
  // D3: a missing in-memory password keeps the token and the host, so the guard
  // needs this explicit signal to ask for the account password again.
  if (loginRequired) return '/relay-login';
  if (!hasToken) return '/relay-login';
  if (!relay.hostId) return '/relay-hosts';
  if (!hostUnlocked) return '/relay-hosts';
  return undefined;
}

// `missing_password` cannot be repaired in place (the process no longer holds
// the account password) but it is not a sign-out either: the refresh module
// marks it here instead of clearing the session, and the root guard reads the
// flag through `useSyncExternalStore`.
let loginRequired = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function relayLoginRequired() {
  return loginRequired;
}

export function markRelayLoginRequired() {
  if (loginRequired) return;
  loginRequired = true;
  notify();
}

export function clearRelayLoginRequired() {
  if (!loginRequired) return;
  loginRequired = false;
  notify();
}

export function subscribeRelayLoginRequired(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
