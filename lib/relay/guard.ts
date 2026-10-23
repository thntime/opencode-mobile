import type { RelayAuth } from './types';

// Pure routing decision for the relay flow, kept separate from `_layout.tsx`
// so the three startup states are unit-testable without mounting the router:
//   no relay block            -> undefined (direct/Cloud users, untouched)
//   relay block, no token     -> /relay-login
//   token, no hostId          -> /relay-hosts
//   token + hostId, locked    -> /relay-hosts (the passphrase is session-only)
//   token + hostId, unlocked  -> undefined (normal tabs)
export type RelayRouteTarget = '/relay-login' | '/relay-hosts' | undefined;

export function relayRouteTarget(relay: RelayAuth | undefined, hasToken: boolean, hostUnlocked = true): RelayRouteTarget {
  if (!relay) return undefined;
  if (!hasToken) return '/relay-login';
  if (!relay.hostId) return '/relay-hosts';
  if (!hostUnlocked) return '/relay-hosts';
  return undefined;
}
