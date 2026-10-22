// In-memory mirror of the SecureStore relay token. `createAuthHeader` is
// synchronous and is called while building clients, so the token is cached here
// after the async auth module reads or writes it. `fetchConnection` resolves the
// token through `getRelayToken()` before every relay request, which hydrates
// this cache on a cold start.
let token: string | undefined;
let loaded = false;

export function cachedRelayToken() {
  return token;
}

export function relayTokenLoaded() {
  return loaded;
}

export function cacheRelayToken(next: string | undefined) {
  token = next;
  loaded = true;
}

export function resetRelayTokenCache() {
  token = undefined;
  loaded = false;
}
