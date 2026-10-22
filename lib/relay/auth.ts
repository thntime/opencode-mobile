import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { SETTINGS_STORAGE_KEY } from '@/lib/storage-keys';

import { cacheRelayToken, cachedRelayToken, relayTokenLoaded, resetRelayTokenCache } from './token-cache';
import { clearRelaySessionPassword, setRelaySessionPassword } from './session-password';
import { normalizeRelayUrl } from './url';

// Single-account Relay login. The JWT lives in one SecureStore slot (multi-account
// switching is out of scope) and its metadata rides the persisted settings
// `relay` field, so a relaunch can restore the session without the password.
export const RELAY_TOKEN_STORAGE_KEY = 'opencode-mobile.relay-token';
// Refresh slightly before the JWT expires; the request layer replays once.
export const RELAY_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export type RelayUser = {
  id?: number;
  email?: string;
};

export type RelayLoginResult = {
  token: string;
  user: RelayUser;
  /** Epoch milliseconds parsed from the JWT `exp` claim, when present. */
  tokenExpiresAt?: number;
};

export type RelayLoginFailure = 'invalid_request' | 'invalid_credentials' | 'unreachable' | 'rejected' | 'invalid_response';

export class RelayLoginError extends Error {
  constructor(public readonly code: RelayLoginFailure, message: string, public readonly status?: number) {
    super(message);
    this.name = 'RelayLoginError';
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Hand-rolled base64url decoding keeps the auth module dependency-free (no
// atob/Buffer dependency on Hermes). `exp` is ASCII, but the payload can carry
// a UTF-8 email, so bytes are decoded as UTF-8 rather than Latin-1.
function decodeBase64Url(value: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value.replace(/=+$/, '')) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base64url payload.');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function decodeTokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as { exp?: unknown };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= 0) return undefined;
    return Math.round(claims.exp * 1000);
  } catch {
    return undefined;
  }
}

// True once the token is inside the refresh window (or already expired). The
// request layer owns the actual refresh; this is the shared predicate.
export function isRelayTokenExpiring(tokenExpiresAt: number | undefined, now = Date.now(), windowMs = RELAY_TOKEN_REFRESH_WINDOW_MS) {
  return typeof tokenExpiresAt === 'number' && Number.isFinite(tokenExpiresAt) && tokenExpiresAt - now <= windowMs;
}

export async function saveRelayToken(token: string) {
  const value = token.trim();
  if (!value) {
    await clearRelayToken();
    return;
  }
  await SecureStore.setItemAsync(RELAY_TOKEN_STORAGE_KEY, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cacheRelayToken(value);
}

export async function getRelayToken(): Promise<string | undefined> {
  if (!relayTokenLoaded()) {
    try {
      cacheRelayToken((await SecureStore.getItemAsync(RELAY_TOKEN_STORAGE_KEY)) ?? undefined);
    } catch {
      // An unavailable keychain behaves like a missing token: requests go out
      // unauthenticated and the connection layer decides how to recover.
      cacheRelayToken(undefined);
    }
  }
  return cachedRelayToken();
}

export async function clearRelayToken() {
  resetRelayTokenCache();
  try {
    await SecureStore.deleteItemAsync(RELAY_TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to delete or the keychain is unavailable; the in-memory cache is
    // already cleared, which is what this session must observe.
  }
}

function parseUser(value: unknown): RelayUser {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.id === 'number' ? { id: record.id } : {}),
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
  };
}

// `POST /api/login` with the Relay account credentials. Success writes the JWT
// to SecureStore; every failure path leaves both SecureStore and settings
// untouched, so the login screen can retry without cleaning up.
export async function login(relayUrl: string, account: string, password: string): Promise<RelayLoginResult> {
  const base = normalizeRelayUrl(relayUrl);
  const email = account.trim();
  if (!base) throw new RelayLoginError('invalid_request', 'Enter the Relay address.');
  if (!email || !password) throw new RelayLoginError('invalid_request', 'Enter the account and password.');

  let response: Response;
  try {
    response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new RelayLoginError('unreachable', 'Could not reach the Relay. Check the address and try again.');
  }

  if (response.status === 401) {
    throw new RelayLoginError('invalid_credentials', 'The account or password is incorrect.', 401);
  }
  if (!response.ok) {
    throw new RelayLoginError('rejected', `The Relay rejected the sign-in (${response.status}).`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RelayLoginError('invalid_response', 'The Relay returned an unreadable response.', response.status);
  }

  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!token) throw new RelayLoginError('invalid_response', 'The Relay did not return a sign-in token.', response.status);

  await saveRelayToken(token);
  // The Relay has no refresh-token endpoint, so the request layer signs in
  // again with these credentials when the JWT nears expiry. The password stays
  // in process memory only; a relaunch degrades to `needsReauth`.
  setRelaySessionPassword(password);
  return { token, user: parseUser(record.user), tokenExpiresAt: decodeTokenExpiry(token) };
}

// Clears the token and the persisted `relay` block. Callers must also reset the
// in-memory settings state; this only guarantees a relaunch cannot resurrect the
// login. Unreadable settings are left untouched rather than overwritten.
export async function logout() {
  await clearRelayToken();
  clearRelaySessionPassword();
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    if (!('relay' in settings)) return;
    delete settings.relay;
    await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A malformed record must not be replaced with an empty one on logout.
  }
}
