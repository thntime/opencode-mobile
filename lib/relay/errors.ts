// Errors raised by the Relay end-to-end encryption layer. The `code` is stable
// so callers can prompt for a passphrase without pattern-matching messages.
export type RelayE2EErrorCode =
  | 'relay_e2e_bad_passphrase'
  | 'relay_e2e_key_unavailable'
  | 'relay_e2e_unauthorized'
  | 'relay_e2e_decrypt_failed'
  | 'relay_e2e_stream_invalid'
  | 'relay_e2e_stream_truncated'
  | 'relay_e2e_unavailable';

export class RelayE2EError extends Error {
  constructor(
    public readonly code: RelayE2EErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayE2EError';
  }
}

export function isRelayE2EError(value: unknown, code?: RelayE2EErrorCode): value is RelayE2EError {
  if (!(value instanceof RelayE2EError)) return false;
  return code === undefined || value.code === code;
}
