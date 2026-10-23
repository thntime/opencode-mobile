import { RelayE2EError } from './errors';

// Session-only host keys. Kept apart from `keywrap.ts` so the request and
// WebSocket layers can read a key without pulling `expo-secure-store` (through
// the auth module) into every fetch consumer.
export const HOST_KEY_BYTES = 32;

const hostKeys = new Map<string, Uint8Array>();
// Hosts whose key material is empty (E2E disabled). They are unlocked without a
// passphrase, and the router must not send the user back to the host picker.
const unlockedWithoutKey = new Set<string>();

export function setHostKey(hostId: string, key: Uint8Array) {
  const id = hostId.trim();
  if (!id) return;
  if (key.length !== HOST_KEY_BYTES) {
    throw new RelayE2EError('relay_e2e_key_unavailable', 'A Relay host key must be 32 bytes.');
  }
  hostKeys.set(id, key);
}

export function getHostKey(hostId: string): Uint8Array | undefined {
  return hostKeys.get(hostId.trim());
}

export function markHostUnlocked(hostId: string) {
  const id = hostId.trim();
  if (id) unlockedWithoutKey.add(id);
}

export function isHostUnlocked(hostId: string): boolean {
  const id = hostId.trim();
  return hostKeys.has(id) || unlockedWithoutKey.has(id);
}

export function clearHostKeys() {
  hostKeys.clear();
  unlockedWithoutKey.clear();
}

export function deleteHostKey(hostId: string) {
  const id = hostId.trim();
  hostKeys.delete(id);
  unlockedWithoutKey.delete(id);
}

// `/relay/{hostId}` is how D1 carries the host id inside `serverUrl`, so the
// request/WS layers can resolve a key without another settings field.
export function relayHostIdFromServerUrl(serverUrl: string): string | undefined {
  const match = /\/relay\/([^/?#]+)/.exec(serverUrl);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function getHostKeyForServerUrl(serverUrl: string): Uint8Array | undefined {
  const hostId = relayHostIdFromServerUrl(serverUrl);
  return hostId ? getHostKey(hostId) : undefined;
}
