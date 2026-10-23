import { encode as encodeBase64 } from 'base-64';
import { fetch as expoFetch } from 'expo/fetch';

import { recordBytes, recordRequest } from '../data-usage';
import { getConnectCredentialError } from '@/lib/connect';
import { isRelayConnectionTarget } from '@/lib/relay/connection-mode';
import { decryptRelayResponse, encryptRelayRequest, relayHostKeyFor } from '@/lib/relay/fetch-e2e';
import { RelayForbiddenError, RelayHostAuthRequiredError, RelayReauthRequiredError, clearRelaySession, refreshRelayToken, relayRefreshError, relayTokenExpiryHint } from '@/lib/relay/refresh';
import { cachedRelayToken } from '@/lib/relay/token-cache';
import { joinUrlPath } from './url';
import type { OpencodeConnectionSettings } from './types';
import type { RelayAuth } from '@/lib/relay/types';
import { fetchWithReadDeadline } from './read-deadline';

export function createAuthHeader(settings: OpencodeConnectionSettings) {
  // Relay connections authenticate with the account JWT, never the host's
  // Basic credential. The token is cached by the auth module; `fetchConnection`
  // hydrates it before every relay request on a cold start.
  if (settings.relay) {
    const token = cachedRelayToken();
    return token ? `Bearer ${token}` : undefined;
  }

  const password = settings.password;
  if (!password) {
    return undefined;
  }

  const username = settings.username.trim() || 'opencode';
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${encodeBase64(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`;
}

export function getRequestHeaders(settings: OpencodeConnectionSettings) {
  const authHeader = createAuthHeader(settings);
  return authHeader
    ? {
        Authorization: authHeader,
      }
    : undefined;
}

// Relay tokens live in SecureStore, so the request path (not the sync header
// builder) resolves them. The dynamic import keeps the native keychain module
// out of callers that never use a relay connection.
function withAuthorization(init: RequestInit | undefined, token: string | undefined): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

// Only an HTTP Basic challenge means the OpenCode host behind the Relay wants
// its own credentials. Other schemes (for example a `Bearer` challenge from the
// Relay itself) describe the Relay's own auth and must go through the normal
// refresh/replay path.
function isHostBasicChallenge(response: Response) {
  const challenge = response.headers.get('www-authenticate');
  return Boolean(challenge && /^\s*basic\b/i.test(challenge));
}

// D4: refresh inside the five-minute window before the request leaves. When the
// Relay has no password in memory the refresh returns `needs_reauth` without a
// network round-trip, and the original request is not sent.
async function relayRequestInit(relay: RelayAuth, init?: RequestInit): Promise<RequestInit | undefined> {
  const { decodeTokenExpiry, getRelayToken, isRelayTokenExpiring } = await import('@/lib/relay/auth');
  const token = await getRelayToken();
  if (!token) return init;
  const expiresAt = decodeTokenExpiry(token) ?? relayTokenExpiryHint(token, relay.tokenExpiresAt);
  if (!isRelayTokenExpiring(expiresAt)) return withAuthorization(init, token);
  const result = await refreshRelayToken(relay.relayUrl, relay.account);
  if (result.status !== 'refreshed') throw relayRefreshError(result.reason);
  return withAuthorization(init, result.token);
}

// Replays the already-prepared init so an encrypted body (a base64 string
// produced once by `encryptRelayRequest`) is reused verbatim instead of being
// encrypted a second time. Streams and other one-shot bodies cannot be replayed.
function isReplayableInit(init?: RequestInit) {
  const body = init?.body;
  if (body === undefined || body === null) return true;
  if (typeof body === 'string' || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return typeof Blob !== 'undefined' && body instanceof Blob;
}

async function replayRelayInit(relay: RelayAuth, init?: RequestInit): Promise<RequestInit | undefined> {
  const result = await refreshRelayToken(relay.relayUrl, relay.account);
  if (result.status !== 'refreshed') throw relayRefreshError(result.reason);
  if (!isReplayableInit(init)) return undefined;
  return withAuthorization(init, result.token);
}

// SDK calls sometimes hand us a fully built Request (for example the PTY
// connect-token call). Its headers and body live on the Request, not on `init`,
// so normalizing first keeps `x-opencode-ticket`, `Content-Type` and the body
// from being dropped when the relay layer rebuilds the init.
async function normalizeRequestInput(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit | undefined> {
  if (typeof Request === 'undefined' || !(input instanceof Request)) return init;
  const headers = new Headers(input.headers);
  let body = init?.body;
  if (body === undefined && !/^(GET|HEAD)$/i.test(input.method)) {
    try {
      body = await input.clone().arrayBuffer();
    } catch {
      body = undefined;
    }
  }
  return { ...init, method: init?.method ?? input.method, headers, body, signal: init?.signal ?? input.signal };
}

export async function fetchConnection(input: RequestInfo | URL, init?: RequestInit, settings?: OpencodeConnectionSettings) {
  // D2: in Relay mode the request target is derived from the `relay` block
  // alone. A leftover direct address (or the empty URL right after signing in)
  // must fail before the bearer token can reach it.
  if (settings?.relay && !isRelayConnectionTarget(settings.serverUrl, settings.relay)) {
    throw new Error('Select a Relay host first. No request was sent.');
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  init = await normalizeRequestInput(input, init);
  if (settings?.connect) {
    const error = getConnectCredentialError(settings.connect, settings.password);
    if (error) throw new Error(error);
  }
  const requestInit = settings?.relay ? await relayRequestInit(settings.relay, init) : init;
  // E2E is opt-in per host: the key only exists after the user unlocked it, so
  // a missing key keeps the direct-connection behavior untouched.
  const hostKey = relayHostKeyFor(settings);
  const preparedInit = hostKey ? await encryptRelayRequest(requestInit, hostKey) : requestInit;
  // RN's XHR ignores redirect rejection. Use Expo for Cloud Link and one-use
  // local pairing requests; other manual connections retain their transport.
  const transport = settings?.connect || preparedInit?.redirect === 'error'
    ? (input: RequestInfo | URL, init?: RequestInit) => expoFetch(input, { ...init, redirect: 'error' })
    : fetch;
  const method = preparedInit?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  const finiteRead = /^(GET|HEAD)$/i.test(method) && !/\/event\/?(?:\?|$)/.test(url);
  const send = (nextInit: RequestInit | undefined) => finiteRead
    ? fetchWithReadDeadline(transport, url, nextInit)
    : transport(url, nextInit);
  let received = await send(preparedInit);
  recordRequest();
  if (settings?.relay && received.status === 401) {
    // A Basic challenge means the 401 came from the OpenCode host behind the
    // Relay, not from the Relay itself: the host wants HTTP Basic and the
    // tunnel client has no credentials for it. That is a host-side
    // configuration problem, so the Relay session and the selected host must
    // survive it.
    if (isHostBasicChallenge(received)) {
      throw new RelayHostAuthRequiredError();
    }
    // One refresh and one replay. A second 401 means the fresh token is also
    // rejected, so the session is unrecoverable in place.
    const replayInit = await replayRelayInit(settings.relay, preparedInit);
    if (!replayInit) {
      throw new Error('The Relay session was refreshed, but this request body cannot be replayed. Retry the request.');
    }
    received = await send(replayInit);
    recordRequest();
    if (received.status === 401) {
      // The replay carried a freshly minted Relay token, so a challenge now can
      // only come from the OpenCode host behind the Relay. Keep the session;
      // only a plain 401 means the Relay rejected the new token too.
      if (isHostBasicChallenge(received)) {
        throw new RelayHostAuthRequiredError();
      }
      await clearRelaySession();
      throw new RelayReauthRequiredError('rejected', true);
    }
  }
  // D4: relay status codes are translated here, before the generic
  // `errors.ts` mapping can turn them into "OpenCode endpoint not found".
  if (settings?.relay) {
    if (received.status === 403) {
      throw new RelayForbiddenError();
    }
    if (received.status === 502 || received.status === 503 || received.status === 504) {
      throw new Error(`Relay 上游不可达（${received.status}）`);
    }
  }
  const response = hostKey ? await decryptRelayResponse(received, hostKey) : received;
  measureResponseBytes(response);
  if (settings?.connect && response.status === 401) throw new Error('Cloud Link credentials were rejected. Pair this device again.');
  if (settings?.connect && response.status === 403) throw new Error('Cloud Link access was denied (403). Check your subscription or device credentials.');
  // Some SDKs discard HTML error bodies, hiding Cloudflare's tunnel-startup code.
  if (settings?.connect && !response.ok && /text\/(?:html|plain)/i.test(response.headers.get('content-type') ?? '')) {
    const body = await response.clone().text();
    if (/\b1033\b/.test(body)) throw new Error('Cloudflare Error 1033');
  }
  return response;
}

// shortcut: counts advertised body sizes only; add streaming accounting if exact
// network diagnostics become necessary, never buffer a second copy to count it.
function measureResponseBytes(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return;
  }
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader ? Number(lengthHeader) : NaN;
  if (Number.isFinite(length) && length >= 0) {
    recordBytes(length);
    return;
  }
}

export function createScopedFetch(baseUrl: string, pathPrefix: string, directory?: string, settings?: OpencodeConnectionSettings) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const currentUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const parsed = new URL(currentUrl, baseUrl);

    if (parsed.origin === baseUrl && pathPrefix && !parsed.pathname.startsWith(`${pathPrefix}/`) && parsed.pathname !== pathPrefix) {
      parsed.pathname = joinUrlPath(pathPrefix, parsed.pathname);
    }
    if (parsed.origin === baseUrl && directory && !parsed.searchParams.has('directory')) {
      parsed.searchParams.set('directory', directory);
    }

    if (typeof input === 'string' || input instanceof URL) {
      return fetchConnection(parsed.toString(), init, settings);
    }

    return fetchConnection(parsed.toString(), {
      body: input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.text(),
      credentials: input.credentials,
      headers: input.headers,
      method: input.method,
      signal: input.signal,
      ...init,
    }, settings);
  };
}

export function createPrefixFetch(origin: string, pathPrefix: string, settings?: OpencodeConnectionSettings) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const currentUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const parsed = new URL(currentUrl, origin);

    if (parsed.origin === origin && pathPrefix && !parsed.pathname.startsWith(`${pathPrefix}/`) && parsed.pathname !== pathPrefix) {
      parsed.pathname = joinUrlPath(pathPrefix, parsed.pathname);
    }

    if (typeof input === 'string' || input instanceof URL) {
      return fetchConnection(parsed.toString(), init, settings);
    }

    return fetchConnection(parsed.toString(), {
      body: input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.text(),
      credentials: input.credentials,
      headers: input.headers,
      method: input.method,
      signal: input.signal,
      ...init,
    }, settings);
  };
}
