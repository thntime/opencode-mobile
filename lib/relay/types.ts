// Relay login state. This is deliberately a plain persisted shape (not a class)
// because it travels through the same AsyncStorage whitelist as `connect`, and
// because old records without it must keep working as direct connections.

export type RelayAuth = {
  /** Relay control plane origin, without the `/relay/{hostId}` prefix. */
  relayUrl: string;
  /** Account (email) used for `POST /api/login`. */
  account: string;
  /** Host chosen on the Relay host list; absent until the user picks one. */
  hostId?: string;
  /** Display name captured at selection time, for offline labels. */
  hostName?: string;
  /** Epoch milliseconds parsed from the JWT `exp` claim. */
  tokenExpiresAt?: number;
};

// A host row from `GET /api/hosts`. `last_seen` stays optional so a Relay that
// omits it still yields a usable list.
export type RelayHost = {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `undefined` means "not a usable relay block"; callers drop the field and keep
// the surrounding record (settings or profile) intact.
export function parseRelayAuth(value: unknown): RelayAuth | undefined {
  if (!isRecord(value)) return undefined;
  const { relayUrl, account, hostId, hostName, tokenExpiresAt } = value;
  if (typeof relayUrl !== 'string' || !relayUrl.trim()) return undefined;
  if (typeof account !== 'string' || !account.trim()) return undefined;
  if (hostId !== undefined && (typeof hostId !== 'string' || !hostId.trim())) return undefined;
  if (hostName !== undefined && typeof hostName !== 'string') return undefined;
  if (tokenExpiresAt !== undefined && (typeof tokenExpiresAt !== 'number' || !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= 0)) return undefined;

  return {
    relayUrl: relayUrl.trim(),
    account: account.trim(),
    ...(typeof hostId === 'string' && hostId.trim() ? { hostId: hostId.trim() } : {}),
    ...(typeof hostName === 'string' && hostName.trim() ? { hostName: hostName.trim() } : {}),
    ...(typeof tokenExpiresAt === 'number' ? { tokenExpiresAt } : {}),
  };
}
