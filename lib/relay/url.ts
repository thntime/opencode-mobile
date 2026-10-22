// Relay URL derivation. The connection's `serverUrl` carries the host id so the
// existing `normalizeServerUrl` path-prefix machinery and `getConnectionScope`
// isolate each host without any new cache key.
export function normalizeRelayUrl(relayUrl: string) {
  const trimmed = relayUrl.trim();
  if (!trimmed) return '';

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

// `{relayUrl}/relay/{hostId}` with duplicate slashes collapsed. Assign the
// result to `settings.serverUrl` when a host is selected; `normalizeServerUrl`
// then splits it into `origin` plus the `/relay/{hostId}` path prefix.
export function buildRelayServerUrl(relayUrl: string, hostId: string) {
  const base = normalizeRelayUrl(relayUrl).replace(/\/+$/, '');
  const host = hostId.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!base) throw new Error('A Relay URL is required to build a host connection.');
  if (!host) throw new Error('A Relay host id is required to build a host connection.');
  return `${base}/relay/${host}`;
}
