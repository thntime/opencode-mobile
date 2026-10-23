import AsyncStorage from '@react-native-async-storage/async-storage';

import { SETTINGS_STORAGE_KEY } from '@/lib/storage-keys';

import { clearHostKeys } from './host-key-cache';
import { clearRelayLoginRequired, markRelayLoginRequired } from './guard';
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

// The process no longer holds the account password (relaunch, cleared session),
// so the token cannot be refreshed in place. This is not a sign-out: the token,
// the host selection and the key material all survive, and the root guard only
// asks for the account password again.
export class RelayLoginRequiredError extends Error {
  readonly code = 'relay_login_required';

  constructor(public readonly reason: RelayRefreshFailure = 'missing_password') {
    super('The Relay needs your account password again. Enter it to continue.');
    this.name = 'RelayLoginRequiredError';
  }
}

// The OpenCode host behind the Relay answered 401 with an HTTP Basic challenge:
// the tunnel client has no credentials for the host. This is a host-side
// configuration problem, so the Relay session, the token and the host selection
// must all survive it.
export class RelayHostAuthRequiredError extends Error {
  readonly code = 'relay_host_auth_required';

  constructor() {
    super('主机要求认证（401）：请在电脑端 ~/.opencode-tunnel/opencode.json 配置 auth_user / auth_password（与 OpenCode 的 server password 一致），然后重启 tunnel-client；或关闭 OpenCode 的 server password。');
    this.name = 'RelayHostAuthRequiredError';
  }
}

// The Relay itself refused the account (403). This is not a rejected
// credential: retrying the sign-in cannot change it, and the selected host must
// survive so the user can pick another one after access is restored.
export class RelayForbiddenError extends Error {
  readonly code = 'relay_forbidden';

  constructor(public readonly reason: RelayRefreshFailure = 'rejected') {
    super('Relay 拒绝了该账号的访问（403）');
    this.name = 'RelayForbiddenError';
  }
}

// The Relay could not be reached at all (timeout, DNS, proxy). The session is
// still valid, so this must never clear the token or drop the host.
export class RelayUnreachableError extends Error {
  readonly code = 'relay_unreachable';

  constructor(public readonly reason: RelayRefreshFailure = 'unreachable') {
    super('Could not reach the Relay. Check your network and try again.');
    this.name = 'RelayUnreachableError';
  }
}

export function isRelayReauthRequired(value: unknown): value is RelayReauthRequiredError {
  if (value instanceof RelayReauthRequiredError) return true;
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'relay_reauth_required';
}

export function isRelayLoginRequired(value: unknown): value is RelayLoginRequiredError {
  if (value instanceof RelayLoginRequiredError) return true;
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'relay_login_required';
}

export function isRelayUnreachable(value: unknown): value is RelayUnreachableError {
  if (value instanceof RelayUnreachableError) return true;
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'relay_unreachable';
}

export function isRelayForbidden(value: unknown): value is RelayForbiddenError {
  if (value instanceof RelayForbiddenError) return true;
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'relay_forbidden';
}

// The failure reason decides both the error type and whether the caller may
// sign the user out. Only a credential the Relay actually rejected maps to
// `RelayReauthRequiredError`; a transport/protocol failure is retryable and
// must leave the session intact. A 403 from `/api/login` is an authorization
// decision: it is fatal but must not clear the token or the host selection.
export function relayRefreshError(reason: RelayRefreshFailure, replayed = false) {
  if (reason === 'missing_password') return new RelayLoginRequiredError(reason);
  if (reason === 'invalid_credentials') return new RelayReauthRequiredError(reason, replayed);
  if (reason === 'rejected') return new RelayForbiddenError(reason);
  return new RelayUnreachableError(reason);
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
    // No password in memory (relaunch, cleared session): nothing can be sent.
    // D3: the persisted token may still be valid, so this must not clear the
    // session or drop the host. The guard only asks for the password again.
    markRelayLoginRequired();
    return { status: 'needs_reauth', reason: 'missing_password' };
  }

  try {
    // Loaded lazily so importing this module does not pull the native keychain
    // into callers that never refresh (the fetch layer imports it eagerly).
    const { login } = await import('./auth');
    const result = await login(relayUrl, account, password);
    lastRefreshedToken = result.token;
    clearRelayLoginRequired();
    return { status: 'refreshed', token: result.token, tokenExpiresAt: result.tokenExpiresAt };
  } catch (reason) {
    const code = typeof reason === 'object' && reason !== null ? (reason as { code?: unknown }).code : undefined;
    const failure: RelayRefreshFailure = typeof code === 'string' ? code as RelayRefreshFailure : 'unreachable';
    // D3: only a credential the Relay actually rejected may destroy the session.
    // A network failure (`unreachable`), throttling, or a malformed response
    // leaves the token and host selection intact.
    if (failure === 'invalid_credentials') {
      await clearRelaySession();
    }
    return { status: 'needs_reauth', reason: failure };
  }
}

// Drops the in-memory token, the session password, and the persisted host
// selection. The account and Relay URL survive so the login screen can be
// pre-filled, while the missing token makes the root guard show /relay-login.
export async function clearRelaySession() {
  // A cleared session can never be waiting for a password again: the guard's
  // login-required signal is about a token that is still valid.
  clearRelayLoginRequired();
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
