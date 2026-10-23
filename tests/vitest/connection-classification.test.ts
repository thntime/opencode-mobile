import { describe, expect, it, vi } from 'vitest';
import {
  classifyConnectionFailure,
  isAuthConnectionFailure,
  isRetryableConnectionFailure,
  isRetryableCloudLinkStartupError,
} from '@/lib/opencode/client/errors';
import { RelayForbiddenError, RelayHostAuthRequiredError } from '@/lib/relay/refresh';

vi.mock('@/lib/opencode/client/types', () => ({ defaultConnectionSettings: { serverUrl: 'http://127.0.0.1:4096' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

describe('connection failure classification', () => {
  it('identifies tunnel startup independently of the transport shape', () => {
    expect(classifyConnectionFailure(new Error('Cloudflare Error 1033'))).toBe('tunnel-startup');
    expect(classifyConnectionFailure('<html>Cloudflare Error 1033</html>')).toBe('tunnel-startup');
  });

  it('classifies credential and entitlement failures before transport retries', () => {
    expect(classifyConnectionFailure({ status: 401, message: 'Unauthorized' })).toBe('auth');
    expect(classifyConnectionFailure(new Error('Cloud Link credentials were rejected. Pair this device again.'))).toBe('auth');
    expect(classifyConnectionFailure(new Error('Cloud Link credentials expired. Restore or renew access to reconnect.'))).toBe('auth');
    expect(classifyConnectionFailure(new Error('Cloud Link credentials are missing. Recover machine access to reconnect.'))).toBe('auth');
    expect(classifyConnectionFailure({ status: 403, message: 'forbidden' })).toBe('auth');
    expect(classifyConnectionFailure(new Error('Cloud Link access was denied (403). Check your subscription or device credentials.'))).toBe('entitlement');
    expect(classifyConnectionFailure(new Error('No active Cloud Link entitlement. Purchase or restore to recover access.'))).toBe('entitlement');
  });

  it('separates an upstream host auth challenge from a rejected credential', () => {
    const error = new RelayHostAuthRequiredError();
    expect(error.code).toBe('relay_host_auth_required');
    // The code short-circuits before the "（401）" in the message is read as a
    // rejected credential: the Relay session is still valid.
    expect(classifyConnectionFailure(error)).toBe('host-auth');
    expect(isAuthConnectionFailure('host-auth')).toBe(false);
    expect(isRetryableConnectionFailure('host-auth')).toBe(false);
    // Regression guard: a plain 401 message still means the connection
    // credentials were rejected.
    expect(classifyConnectionFailure(new Error('Relay 拒绝了该账号的访问（401）'))).toBe('auth');
    expect(classifyConnectionFailure(new Error('主机要求认证（401）'))).toBe('auth');
  });

  it('separates a Relay account 403 from a rejected credential', () => {
    const error = new RelayForbiddenError();
    expect(error.code).toBe('relay_forbidden');
    expect(classifyConnectionFailure(error)).toBe('forbidden');
    // Not an auth failure: the selected host must survive and no sign-out is due.
    expect(isAuthConnectionFailure('forbidden')).toBe(false);
    expect(isRetryableConnectionFailure('forbidden')).toBe(false);
  });

  // I4: some SDK wrappers flatten the error and drop `code`. A 403 whose body
  // is the Relay's account message must still be forbidden, not auth, or the
  // selected host is dropped as if the token had been rejected.
  it('recognizes a Relay 403 by message when the wrapper loses the code', () => {
    expect(classifyConnectionFailure(new Error('Relay 拒绝了该账号的访问（403）'))).toBe('forbidden');
    expect(classifyConnectionFailure(new Error('Relay 拒绝了该账号的访问'))).toBe('forbidden');
  });

  it('separates offline transitions from timeouts and protocol mismatches', () => {
    expect(classifyConnectionFailure(new Error('Network is unreachable'))).toBe('offline');
    expect(classifyConnectionFailure(new Error('fetch failed', { cause: { code: 'ENETUNREACH' } }))).toBe('offline');
    expect(classifyConnectionFailure({ domain: 'NSURLErrorDomain', code: -1009 })).toBe('offline');
    expect(classifyConnectionFailure(new Error('Connection timed out'))).toBe('timeout');
    expect(classifyConnectionFailure(new Error('Unable to resolve host machine.test'))).toBe('timeout');
    expect(classifyConnectionFailure(new Error('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe('timeout');
    expect(classifyConnectionFailure({ domain: 'NSURLErrorDomain', code: -1003 })).toBe('timeout');
    expect(classifyConnectionFailure(new Error('ECONNRESET'))).toBe('timeout');
    expect(classifyConnectionFailure(new Error('MalformedResponse'))).toBe('server-incompatible');
    expect(classifyConnectionFailure(new Error('unsupported content type'))).toBe('server-incompatible');
  });

  it('keeps ambiguous and security failures in the non-retryable unknown bucket', () => {
    expect(classifyConnectionFailure(new Error('fetch failed'))).toBe('unknown');
    expect(classifyConnectionFailure(new Error('Network request failed'))).toBe('unknown');
    expect(classifyConnectionFailure(new Error('certificate expired'))).toBe('unknown');
    expect(classifyConnectionFailure(new Error('Invalid server URL.'))).toBe('unknown');
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(classifyConnectionFailure(cyclic)).toBe('unknown');
  });

  it('maps classification onto the retry and auth policies', () => {
    for (const kind of ['timeout', 'offline', 'tunnel-startup', 'unknown'] as const) {
      expect(isRetryableConnectionFailure(kind)).toBe(true);
      expect(isAuthConnectionFailure(kind)).toBe(false);
    }
    for (const kind of ['auth', 'entitlement'] as const) {
      expect(isRetryableConnectionFailure(kind)).toBe(false);
      expect(isAuthConnectionFailure(kind)).toBe(true);
    }
    expect(isRetryableConnectionFailure('server-incompatible')).toBe(false);
    expect(isAuthConnectionFailure('server-incompatible')).toBe(false);
  });

  it('keeps the Cloud Link startup gate behavior unchanged', () => {
    expect(isRetryableCloudLinkStartupError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableCloudLinkStartupError(new Error('Network request failed'))).toBe(false);
    expect(isRetryableCloudLinkStartupError({ status: 403, message: '1033' })).toBe(false);
  });
});
