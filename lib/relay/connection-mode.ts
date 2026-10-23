import { normalizeConnectionUrl } from '@/lib/connection-scope';
import type { RelayAuth } from './types';
import { buildRelayServerUrl, normalizeRelayUrl } from './url';

// D1: `settings.relay` is the single mode switch. Direct and Relay connections
// never share a request target, so entering Relay mode must drop the direct
// address and credentials in the same write that adds the `relay` block.
// `serverUrl` stays empty until a host is chosen (`buildRelayServerUrl`).
//
// Signing in again with the same Relay account must not discard the host the
// user already picked: `previous` carries the active settings, and when the
// Relay URL/account are unchanged the host fields are preserved and the target
// is rebuilt so the guard does not report "select a host" again.
export function relayModeSettings(relay: RelayAuth, previous?: { relay?: RelayAuth }) {
  const sameAccount = Boolean(previous?.relay)
    && normalizeRelayUrl(previous!.relay!.relayUrl) === normalizeRelayUrl(relay.relayUrl)
    && previous!.relay!.account.trim() === relay.account.trim();
  const nextRelay: RelayAuth = sameAccount
    ? {
        ...relay,
        ...(previous!.relay!.hostId ? { hostId: previous!.relay!.hostId } : {}),
        ...(previous!.relay!.hostName ? { hostName: previous!.relay!.hostName } : {}),
      }
    : relay;
  return {
    relay: nextRelay,
    serverUrl: nextRelay.hostId ? buildRelayServerUrl(nextRelay.relayUrl, nextRelay.hostId) : '',
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
  // Compare canonical spellings so case differences in the scheme/host,
  // trailing slashes, and default ports do not reject a valid target.
  return targetKey(serverUrl) === targetKey(expected);
}

function targetKey(value: string) {
  const url = normalizeConnectionUrl(value);
  return `${url.origin}${url.pathAndQuery}`;
}
