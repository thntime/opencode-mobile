import { gcm } from '@noble/ciphers/aes';
import { scrypt } from '@noble/hashes/scrypt';

import { relayFetch } from './authenticated-fetch';
import { decodeBase64Bytes } from './base64';
import { RelayE2EError } from './errors';
import { deleteHostKey, HOST_KEY_BYTES, setHostKey } from './host-key-cache';
import { ensureRandomSource } from './random';
import { isRelayReauthRequired } from './refresh';
import { setPassphrase } from './session-key';
import { normalizeRelayUrl } from './url';

// D5: KEK = scrypt(passphrase, salt, N=2^15, r=8, p=1, dkLen=32). The tunnel
// client derives the same material, so the wrapped host key can be unwrapped on
// either side.
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
export { clearHostKeys, getHostKey, getHostKeyForServerUrl, HOST_KEY_BYTES, relayHostIdFromServerUrl, setHostKey } from './host-key-cache';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ACCEPTED_KDFS = new Set(['', 'scrypt', 'scrypt-n15-r8-p1']);

export type RelayHostKeyMaterial = {
  /** Base64 of `nonce(12) || ciphertext || tag(16)`, as reported by the tunnel. */
  wrapped: string;
  /** Base64 scrypt salt. */
  salt: string;
  /** KDF identifier; empty on older tunnels. */
  kdf: string;
};

export function deriveKek(passphrase: string, salt: Uint8Array): Uint8Array {
  return scrypt(new TextEncoder().encode(passphrase), salt, SCRYPT_PARAMS);
}

// `wrapped` is base64(nonce || ciphertext || tag) produced by the tunnel's
// `encrypt`. Any failure (bad base64, short payload, wrong KEK/tag) is reported
// as a bad passphrase: the underlying cause is indistinguishable to the user
// and must not leak key material.
export function unwrapHostKey(wrappedBase64: string, kek: Uint8Array): Uint8Array {
  if (kek.length !== HOST_KEY_BYTES) {
    throw new RelayE2EError('relay_e2e_key_unavailable', 'A Relay key-encryption key must be 32 bytes.');
  }

  let data: Uint8Array;
  try {
    data = decodeBase64Bytes(wrappedBase64.trim());
  } catch {
    throw new RelayE2EError('relay_e2e_bad_passphrase', 'The Relay host key could not be unwrapped.');
  }
  if (data.length < NONCE_BYTES + TAG_BYTES) {
    throw new RelayE2EError('relay_e2e_bad_passphrase', 'The Relay host key could not be unwrapped.');
  }

  try {
    const key = gcm(kek, data.subarray(0, NONCE_BYTES)).decrypt(data.subarray(NONCE_BYTES));
    if (key.length !== HOST_KEY_BYTES) {
      throw new Error('Unexpected host key length.');
    }
    return key;
  } catch {
    throw new RelayE2EError('relay_e2e_bad_passphrase', 'The Relay passphrase is incorrect.');
  }
}

export async function fetchHostKey(relayUrl: string, hostId: string, token?: string, account?: string): Promise<RelayHostKeyMaterial> {
  const base = normalizeRelayUrl(relayUrl);
  const host = hostId.trim();
  if (!base) throw new RelayE2EError('relay_e2e_key_unavailable', 'A Relay URL is required to fetch the host key.');
  if (!host) throw new RelayE2EError('relay_e2e_key_unavailable', 'A Relay host id is required to fetch the host key.');

  let response: Response;
  try {
    // The control plane shares the data plane's refresh policy: an expiring
    // token is renewed first, and a 401 is refreshed and replayed once.
    response = await relayFetch(
      base,
      `/api/hosts/${encodeURIComponent(host)}/key`,
      { headers: { Accept: 'application/json' } },
      { token, account },
    );
  } catch (error) {
    if (isRelayReauthRequired(error)) {
      // A replayed request that is still rejected means the session itself is
      // fine but this request is not authorized: the passphrase flow can retry
      // instead of forcing a sign-out. A failed refresh keeps propagating as
      // `relay_reauth_required`.
      if (error.replayed) {
        throw new RelayE2EError('relay_e2e_unauthorized', 'The Relay rejected the host key request.', 401);
      }
      throw error;
    }
    throw new RelayE2EError('relay_e2e_key_unavailable', 'Could not reach the Relay to fetch the host key.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new RelayE2EError('relay_e2e_unauthorized', 'The Relay rejected the host key request.', response.status);
  }
  if (!response.ok) {
    throw new RelayE2EError('relay_e2e_key_unavailable', `The Relay did not return a host key (${response.status}).`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RelayE2EError('relay_e2e_key_unavailable', 'The Relay returned an unreadable host key.', response.status);
  }

  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const wrapped = typeof record.key_wrapped === 'string' ? record.key_wrapped.trim() : '';
  const salt = typeof record.key_salt === 'string' ? record.key_salt.trim() : '';
  const kdf = typeof record.key_kdf === 'string' ? record.key_kdf.trim() : '';

  if (!ACCEPTED_KDFS.has(kdf)) {
    throw new RelayE2EError('relay_e2e_key_unavailable', `Unsupported Relay key derivation (${kdf}).`);
  }
  if (wrapped && !salt) {
    throw new RelayE2EError('relay_e2e_key_unavailable', 'The Relay host key is missing its salt.');
  }

  return { wrapped, salt, kdf };
}

// One call for the whole D5 unlock: fetch the wrapped key, derive the KEK and
// cache the host key. `undefined` means the host has no E2E key (the user may
// skip the passphrase); a wrong passphrase rejects with
// `relay_e2e_bad_passphrase` so the UI can re-prompt.
export async function unlockHostKey({ relayUrl, hostId, passphrase, token, account }: {
  relayUrl: string;
  hostId: string;
  passphrase: string;
  token?: string;
  account?: string;
}): Promise<Uint8Array | undefined> {
  const host = hostId.trim();
  if (!host) throw new RelayE2EError('relay_e2e_key_unavailable', 'A Relay host id is required to unlock the host.');

  await ensureRandomSource();
  try {
    const material = await fetchHostKey(relayUrl, host, token, account);
    if (!material.wrapped) {
      deleteHostKey(host);
      return undefined;
    }

    const kek = deriveKek(passphrase, decodeBase64Bytes(material.salt));
    const key = unwrapHostKey(material.wrapped, kek);
    setHostKey(host, key);
    // Remember the passphrase for the session so a reconnect of the same host
    // does not re-prompt. Switching hosts clears the cache; it is never
    // persisted.
    setPassphrase(passphrase);
    return key;
  } catch (error) {
    // A failed unlock must never leave a previous key active for this host.
    deleteHostKey(host);
    throw error;
  }
}
