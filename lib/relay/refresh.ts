import AsyncStorage from '@react-native-async-storage/async-storage';

import { SETTINGS_STORAGE_KEY } from '@/lib/storage-keys';

import { clearHostKeys } from './host-key-cache';
import { clearPassphrase } from './session-key';
import { clearRelaySessionPassword, getRelaySessionPassword } from './session-password';
import type { RelayAuth } from './types';

// The Relay only exposes `POST /api/login`; there is no refresh-token endpoint.
// "Refreshing" therefore means signing in again with the account credentials
// kept in memory for this process (see `session-password.ts`). The persisted
// settings only carry the account, never the password.
export type RelayRefreshFailure =
  | 'missing_password'
  | 'invalid_request'
  | 'invalid_credentials'
  | 'unreachable'
  | 'rejected'
  | 'invalid_response';

export type RelayRefreshResult =
  | { status: 'refreshed'; token: string; tokenExpiresAt?: number }
  | { status: 'needs_reauth'; reason: RelayRefreshFailure };

export class RelayReauthRequiredError extends Error {
  readonly code = 'relay_reauth_required';

  constructor(
    public readonly reason: RelayRefreshFailure,
    /** True when a freshly minted token was also rejected (a replay 401). */
    public readonly replayed = false,
  ) {
    super('The Relay session expired. Sign in again.');
    this.name = 'RelayReauthRequiredError';
  }
}

export function isRelayReauthRequired(value: unknown): value is RelayReauthRequiredError {
  if (value instanceof RelayReauthRequiredError) return true;
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'relay_reauth_required';
}

// Concurrent 401s share one sign-in so a burst of requests cannot burn several
// login round-trips (or race two tokens into SecureStore).
let inFlight: { key: string; promise: Promise<RelayRefreshResult> } | undefined;
// An opaque refreshed token carries no `exp`; remembering it prevents the
// previous token's persisted expiry from triggering a refresh on every request.
let lastRefreshedToken: string | undefined;

export function resetRelayRefreshState() {
  inFlight = undefined;
  lastRefreshedToken = undefined;
}

// `persistedExpiresAt` belongs to whatever token was saved with the settings.
// Once a newer opaque token was minted in this process it no longer describes
// the live token, so it must not drive the pre-request refresh decision.
export function relayTokenExpiryHint(token: string, persistedExpiresAt?: number) {
  if (token === lastRefreshedToken) return undefined;
  return persistedExpiresAt;
}

export function refreshRelayToken(
  relayUrl: string,
  account: string,
  passwordProvider?: () => string | undefined | Promise<string | undefined>,
): Promise<RelayRefreshResult> {
  const key = `${relayUrl}\u0000${account}`;
  if (inFlight?.key === key) return inFlight.promise;
  let promise: Promise<RelayRefreshResult>;
  promise = performRefresh(relayUrl, account, passwordProvider).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { key, promise };
  return promise;
}

async function performRefresh(
  relayUrl: string,
  account: string,
  passwordProvider?: () => string | undefined | Promise<string | undefined>,
): Promise<RelayRefreshResult> {
  let password: string | undefined;
  try {
    password = passwordProvider ? await passwordProvider() : getRelaySessionPassword();
  } catch {
    password = undefined;
  }
  if (!password) {
    // No password in memory (relaunch, cleared session): nothing to send, and
    // the user must sign in again. Clear the stale token so the root guard
    // routes to /relay-login.
    await clearRelaySession();
    return { status: 'needs_reauth', reason: 'missing_password' };
  }

  try {
    // Loaded lazily so importing this module does not pull the native keychain
    // into callers that never refresh (the fetch layer imports it eagerly).
    const { login } = await import('./auth');
    const result = await login(relayUrl, account, password);
    lastRefreshedToken = result.token;
    return { status: 'refreshed', token: result.token, tokenExpiresAt: result.tokenExpiresAt };
  } catch (reason) {
    const code = typeof reason === 'object' && reason !== null ? (reason as { code?: unknown }).code : undefined;
    await clearRelaySession();
    return {
      status: 'needs_reauth',
      reason: typeof code === 'string' ? code as RelayRefreshFailure : 'unreachable',
    };
  }
}

// Drops the in-memory token, the session password, and the persisted host
// selection. The account and Relay URL survive so the login screen can be
// pre-filled, while the missing token makes the root guard show /relay-login.
export async function clearRelaySession() {
  // Host keys and the E2E passphrase belong to the signed-in account. Clearing
  // them here keeps a later sign-in from reusing key material unlocked by the
  // previous session.
  clearHostKeys();
  clearPassphrase();
  // Loaded lazily so this module (imported eagerly by the fetch layer) does not
  // pull the native keychain into callers that never touch a Relay.
  const { clearRelayToken } = await import('./auth');
  await clearRelayToken();
  clearRelaySessionPassword();
  await clearPersistedRelayHost();
}

async function clearPersistedRelayHost() {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    const relay = settings.relay;
    if (!relay || typeof relay !== 'object' || Array.isArray(relay)) return;
    const record = relay as Record<string, unknown>;
    if (!('hostId' in record) && !('hostName' in record) && !('tokenExpiresAt' in record)) return;
    delete record.hostId;
    delete record.hostName;
    delete record.tokenExpiresAt;
    await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Unreadable settings are left untouched: the in-memory token is already
    // gone, which is what this session observes.
  }
}

// In-memory counterpart of the persisted cleanup above. The provider applies
// this so the root guard re-evaluates without waiting for a relaunch.
export function relayWithoutHost(relay: RelayAuth): RelayAuth {
  return { relayUrl: relay.relayUrl, account: relay.account };
}
