import type { RelayAuth } from './types';
import { buildRelayServerUrl } from './url';

// D1: `settings.relay` is the single mode switch. Direct and Relay connections
// never share a request target, so entering Relay mode must drop the direct
// address and credentials in the same write that adds the `relay` block.
// `serverUrl` stays empty until a host is chosen (`buildRelayServerUrl`).
export function relayModeSettings(relay: RelayAuth) {
  return {
    relay,
    serverUrl: '',
    username: '',
    password: undefined,
    connect: undefined,
  };
}

// D2: in Relay mode the only valid request target is derived from the `relay`
// block. A leftover direct address (or an empty URL before a host is picked)
// must fail before any request leaves the app.
export function isRelayConnectionTarget(serverUrl: string, relay: RelayAuth): boolean {
  if (!relay.hostId) return false;
  let expected: string;
  try {
    expected = buildRelayServerUrl(relay.relayUrl, relay.hostId);
  } catch {
    return false;
  }
  return serverUrl.trim().replace(/\/+$/, '') === expected;
}
