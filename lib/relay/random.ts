import { RelayE2EError } from './errors';

type RandomSource = (length: number) => Uint8Array;

let source: RandomSource | undefined;

// Tests and non-native runtimes inject a deterministic source; the app itself
// installs `expo-crypto` lazily so importing the relay modules in Node (Vitest,
// static checks) never pulls a native module.
export function setRandomBytesSource(next: RandomSource | undefined) {
  source = next;
}

export function randomBytes(length: number): Uint8Array {
  if (source) return source(length);

  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(length);
    webCrypto.getRandomValues(bytes);
    return bytes;
  }

  throw new RelayE2EError('relay_e2e_unavailable', 'No secure random source is available for Relay encryption.');
}

// Native runtimes have no global Web Crypto in older Hermes builds, so the
// first successful unlock installs expo-crypto as the source. Failure falls back
// to `globalThis.crypto` (web, Node) and leaves the error to `randomBytes`.
export async function ensureRandomSource(): Promise<void> {
  if (source) return;
  try {
    const expo = await import('expo-crypto');
    if (typeof expo.getRandomBytes === 'function') {
      source = (length: number) => expo.getRandomBytes(length);
    }
  } catch {
    // No native module here: Web Crypto below is the fallback.
  }
}
