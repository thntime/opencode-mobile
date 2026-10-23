import AsyncStorage from '@react-native-async-storage/async-storage';

import { SETTINGS_STORAGE_KEY } from '@/lib/storage-keys';

import { decodeTokenExpiry, getRelayToken, isRelayTokenExpiring } from './auth';
import { RelayReauthRequiredError, refreshRelayToken, relayRefreshError, relayTokenExpiryHint } from './refresh';
import { parseRelayAuth, type RelayAuth } from './types';
import { normalizeRelayUrl } from './url';

// Control-plane requests (`/api/hosts`, `/api/hosts/{id}/key`) authenticate with
// the same account JWT as the data plane. They must share its refresh policy:
// a JWT inside the refresh window is renewed before the request leaves, and a
// 401 triggers one refresh + one replay before the session is declared dead.
// Without this, an expiring token would surface as a hard sign-out even though
// the in-memory password can mint a fresh one silently.
export type RelayFetchOptions = {
  /** Account for the silent re-login; falls back to the persisted settings. */
  account?: string;
  /** Pre-resolved bearer (e.g. a token passed into `fetchHostKey`). */
  token?: string;
};

function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

// The Relay account lives in the persisted settings, not in the request call
// sites, so a control-plane fetch can refresh without threading credentials
// through every helper. Read lazily: the happy path never touches storage.
async function persistedRelay(relayUrl: string): Promise<RelayAuth | undefined> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return undefined;
    const settings = JSON.parse(raw) as { relay?: unknown };
    const relay = parseRelayAuth(settings?.relay);
    if (!relay) return undefined;
    return normalizeRelayUrl(relay.relayUrl) === normalizeRelayUrl(relayUrl) ? relay : undefined;
  } catch {
    return undefined;
  }
}

async function refreshToken(relayUrl: string, account: string | undefined): Promise<string> {
  // An absent account cannot refresh; `login` rejects it as `invalid_request`
  // and `performRefresh` classifies it, which is the correct outcome. Passing
  // an empty string keeps the failure path uniform.
  const result = await refreshRelayToken(relayUrl, account?.trim() ?? '');
  if (result.status !== 'refreshed') throw relayRefreshError(result.reason);
  return result.token;
}

export async function relayFetch(
  relayUrl: string,
  path: string,
  init?: RequestInit,
  options: RelayFetchOptions = {},
): Promise<Response> {
  const base = normalizeRelayUrl(relayUrl);
  if (!base) throw new Error('A Relay URL is required.');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  let persisted: RelayAuth | undefined;
  const resolveAccount = async () => {
    const explicit = options.account?.trim();
    if (explicit) return explicit;
    persisted ??= await persistedRelay(base);
    return persisted?.account;
  };

  let token = options.token?.trim() || (await getRelayToken());
  if (!token) {
    // No cached token (cold start after a keychain read) can still recover when
    // the in-memory password is available.
    token = await refreshToken(base, await resolveAccount());
  } else {
    let expiresAt = decodeTokenExpiry(token);
    if (expiresAt === undefined && !options.token) {
      // An opaque token minted by an earlier process carries no `exp`; the
      // persisted expiry describes it. An explicitly passed token may not match
      // the persisted one, so it is never combined with that hint.
      persisted ??= await persistedRelay(base);
      expiresAt = relayTokenExpiryHint(token, persisted?.tokenExpiresAt);
    }
    if (isRelayTokenExpiring(expiresAt)) {
      token = await refreshToken(base, await resolveAccount());
    }
  }

  let response = await fetch(url, withAuthorization(init, token));
  if (response.status === 401) {
    // One refresh and one replay with the same init (the body is not rebuilt),
    // matching `fetchConnection`. A second 401 means the fresh token is also
    // rejected, so the session cannot heal in place.
    // Control-plane requests must stay replayable (no body or a static body).
    // If a streaming/POST body is ever added here, reuse the data plane's
    // `isReplayableInit` guard before replaying instead of resending blindly.
    const replayToken = await refreshToken(base, await resolveAccount());
    response = await fetch(url, withAuthorization(init, replayToken));
    if (response.status === 401) throw new RelayReauthRequiredError('rejected', true);
  }
  return response;
}
