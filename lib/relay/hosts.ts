import { relayFetch } from './authenticated-fetch';
import { isRelayReauthRequired } from './refresh';
import type { RelayHost } from './types';
import { normalizeRelayUrl } from './url';

// `GET /api/hosts` on the Relay control plane. Kept in lib (not the screen)
// because the architecture contract forbids fetch calls in app/ and
// components/. Failures throw plain Errors with translated-by-caller messages;
// the screen maps them to its error slot.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHost(value: unknown): RelayHost | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, online, last_seen: lastSeen } = value;
  if (typeof id !== 'string' || !id.trim()) return undefined;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  return {
    id: id.trim(),
    name: name.trim(),
    online: online === true,
    ...(typeof lastSeen === 'string' && lastSeen.trim() ? { lastSeen: lastSeen.trim() } : {}),
  };
}

export async function fetchRelayHosts(relayUrl: string, account?: string): Promise<RelayHost[]> {
  const base = normalizeRelayUrl(relayUrl);
  if (!base) throw new Error('A Relay URL is required to list hosts.');

  let response: Response;
  try {
    response = await relayFetch(base, '/api/hosts', undefined, { account });
  } catch (error) {
    // A refresh that cannot mint a token (or a replayed 401) must reach the
    // screen as `relay_reauth_required` so it can sign out exactly once.
    if (isRelayReauthRequired(error)) throw error;
    throw new Error('Could not reach the Relay. Check the address and try again.');
  }
  if (!response.ok) {
    throw new Error(`The Relay rejected the host list (${response.status}).`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The Relay returned an unreadable host list.');
  }
  if (!Array.isArray(body)) throw new Error('The Relay returned an unreadable host list.');
  return body.map(parseHost).filter((host): host is RelayHost => Boolean(host));
}
