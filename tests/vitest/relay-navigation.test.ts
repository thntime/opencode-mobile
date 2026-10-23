import { describe, expect, it } from 'vitest';

import { clearRelayLoginRequired, markRelayLoginRequired, relayLoginRequired, relayRouteTarget } from '@/lib/relay/guard';

// Navigation contract from the design's Testing Strategy: each startup state
// lands on exactly one surface, and direct connections are never redirected.
describe('relay route guard', () => {
  const base = { relayUrl: 'https://relay.example.com', account: 'a@example.com' };

  it('leaves direct connections (no relay block) untouched', () => {
    expect(relayRouteTarget(undefined, false)).toBeUndefined();
    expect(relayRouteTarget(undefined, true)).toBeUndefined();
  });

  it('sends a relay block without a token to relay-login', () => {
    expect(relayRouteTarget(base, false)).toBe('/relay-login');
    expect(relayRouteTarget({ ...base, hostId: 'host-1' }, false)).toBe('/relay-login');
  });

  it('sends a signed-in session without a hostId to relay-hosts', () => {
    expect(relayRouteTarget(base, true)).toBe('/relay-hosts');
  });

  it('lets a fully configured relay session fall through to the tabs', () => {
    expect(relayRouteTarget({ ...base, hostId: 'host-1', hostName: 'Workstation' }, true)).toBeUndefined();
  });

  // D3: losing the in-memory password no longer clears the token, so the guard
  // needs an explicit signal to send the user back for the account password.
  it('routes to relay-login when the session needs the account password again', () => {
    expect(relayRouteTarget({ ...base, hostId: 'host-1' }, true, true, true)).toBe('/relay-login');
    expect(relayRouteTarget({ ...base, hostId: 'host-1' }, false, false, true)).toBe('/relay-login');
  });

  it('never redirects direct connections even when the signal is stale', () => {
    expect(relayRouteTarget(undefined, true, true, true)).toBeUndefined();
  });

  it('keeps the signal out of the way until a refresh asks for the password', () => {
    clearRelayLoginRequired();
    expect(relayLoginRequired()).toBe(false);
    markRelayLoginRequired();
    expect(relayLoginRequired()).toBe(true);
    clearRelayLoginRequired();
    expect(relayLoginRequired()).toBe(false);
  });
});
