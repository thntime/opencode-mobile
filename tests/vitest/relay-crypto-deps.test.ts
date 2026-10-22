import { describe, expect, it } from 'vitest';
import { gcm } from '@noble/ciphers/aes';
import { scrypt } from '@noble/hashes/scrypt';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The relay login flow derives a KEK with scrypt and unwraps the host key with
// AES-256-GCM. This suite is the smoke test that both pure-JS primitives load
// and interoperate under the Vitest/Hermes-compatible package builds.
describe('relay crypto dependencies', () => {
  it('derives a 32-byte key with scrypt', () => {
    const key = scrypt(encoder.encode('correct horse battery staple'), encoder.encode('relay-salt'), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
  });

  it('round-trips bytes through AES-256-GCM', () => {
    const key = scrypt(encoder.encode('relay passphrase'), encoder.encode('relay-salt'), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
    const nonce = new Uint8Array(12).fill(7);
    const plaintext = encoder.encode('host key payload 🔑');
    const ciphertext = gcm(key, nonce).encrypt(plaintext);

    expect(ciphertext).toHaveLength(plaintext.length + 16);
    expect(decoder.decode(gcm(key, nonce).decrypt(ciphertext))).toBe('host key payload 🔑');
  });

  it('rejects a wrong key instead of returning plaintext', () => {
    const nonce = new Uint8Array(12).fill(1);
    const ciphertext = gcm(new Uint8Array(32).fill(1), nonce).encrypt(encoder.encode('secret'));
    expect(() => gcm(new Uint8Array(32).fill(2), nonce).decrypt(ciphertext)).toThrow();
  });
});
