import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptFrame, encryptFrame } from '@/lib/relay/crypto';
import { clearHostKeys, setHostKey } from '@/lib/relay/keywrap';
import { encryptTerminalSocket } from '@/lib/relay/ws';
import { openTerminalWebSocket } from '@/providers/services/terminal-service';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
vi.mock('@/lib/connect', () => ({ getConnectCredentialError: () => undefined }));
vi.mock('@/lib/opencode/data-usage', () => ({ recordRequest: vi.fn(), recordBytes: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: async () => 'jwt-token',
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hostKey = new Uint8Array(32).fill(5);
const otherKey = new Uint8Array(32).fill(6);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
// Ciphertext frames carry the original opcode as the first plaintext byte.
const sealText = (text: string, key: Uint8Array) => {
  const body = encoder.encode(text);
  const framed = new Uint8Array(body.length + 1);
  framed[0] = 1;
  framed.set(body, 1);
  return encryptFrame(framed, key);
};

class FakeSocket {
  binaryType = 'blob';
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  options: unknown;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private listeners: ((event: MessageEvent) => void)[] = [];

  constructor(public url: string, _protocols?: unknown, options?: unknown) {
    this.options = options;
    FakeSocket.instances.push(this);
  }

  static instances: FakeSocket[] = [];

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners = this.listeners.filter((entry) => entry !== listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  receive(data: unknown) {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

function fake(): FakeSocket {
  return new FakeSocket('wss://relay.example.test/relay/host-a/api/pty/pty-1/connect');
}

beforeEach(() => {
  clearHostKeys();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay E2E terminal frames', () => {
  it('decrypts incoming frames before the terminal handler sees them', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    wrapped.onmessage = (event) => seen.push(event.data);

    expect(socket.binaryType).toBe('arraybuffer');
    socket.receive(sealText('$ ls\r\n', hostKey));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('$ ls\r\n');
  });

  it('decrypts frames for addEventListener consumers', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    const listener = (event: MessageEvent) => seen.push(event.data);
    wrapped.addEventListener('message', listener as unknown as EventListener);

    socket.receive(sealText('$ pwd\r\n', hostKey));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('$ pwd\r\n');

    wrapped.removeEventListener('message', listener as unknown as EventListener);
    socket.receive(sealText('after', hostKey));
    expect(seen).toHaveLength(1);
  });

  it('decrypts outgoing frames as raw nonce||ciphertext||tag', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);

    wrapped.send('ls\r');

    expect(socket.sent).toHaveLength(1);
    expect(typeof socket.sent[0]).not.toBe('string');
    const plain = decryptFrame(socket.sent[0] as Uint8Array, hostKey);
    expect(plain[0]).toBe(1);
    expect(decoder.decode(plain.subarray(1))).toBe('ls\r');
  });

  it('decrypts a frame produced by the Go tunnel client', () => {
    const socket = fake();
    const goHostKey = fromHex('8f1c2d3e4a5b6c7d8e9f00112233445566778899aabbccddeeff001122334455');
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, goHostKey);
    const seen: unknown[] = [];
    wrapped.onmessage = (event) => seen.push(event.data);

    // Go `encryptStreamPayload` output for opcode 1 + `\0{"cursor":42}`.
    socket.receive(fromHex('000102030405060708090a0b853ab7501fc1d528e5aa65432c17751e1d1efa659359ba6956714a157e2c18'));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('\u0000{"cursor":42}');
  });

  it('rejects a plaintext frame instead of rendering it', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    wrapped.onmessage = (event) => seen.push(event.data);

    socket.receive('plain');

    expect(seen).toEqual([]);
    expect(socket.closed?.code).toBe(1011);
  });

  it('isolates throwing handlers so the remaining listeners still run', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const failure = new Error('handler exploded');
    const seen: unknown[] = [];
    const scheduled: Array<() => void> = [];
    vi.stubGlobal('setTimeout', ((callback: () => void) => { scheduled.push(callback); return 0; }) as unknown as typeof setTimeout);
    wrapped.onmessage = () => { throw failure; };
    wrapped.addEventListener('message', (event) => seen.push(event.data));

    socket.receive(sealText('$ ls\r\n', hostKey));

    // DOM EventTarget semantics: one bad listener neither stops its siblings
    // nor tears down the socket.
    expect(seen).toHaveLength(1);
    expect(socket.closed).toBeUndefined();
    // The error is not swallowed: it is re-thrown from a macrotask.
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]()).toThrow(failure);
  });

  it('removes once listeners after the first frame', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    const listener = (event: MessageEvent) => seen.push(event.data);
    wrapped.addEventListener('message', listener as unknown as EventListener, { once: true });

    socket.receive(sealText('first', hostKey));
    socket.receive(sealText('second', hostKey));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('first');
  });

  it('ignores the capture flag because the encrypted socket has a single target', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    const listener = (event: MessageEvent) => seen.push(event.data);
    wrapped.addEventListener('message', listener as unknown as EventListener, { capture: true });

    socket.receive(sealText('$ pwd\r\n', hostKey));

    expect(seen).toHaveLength(1);
  });

  it('closes with 1011 semantics when a frame cannot be decrypted', () => {
    const socket = fake();
    const wrapped = encryptTerminalSocket(socket as unknown as WebSocket, hostKey);
    const seen: unknown[] = [];
    wrapped.onmessage = (event) => seen.push(event.data);

    socket.receive(sealText('poisoned', otherKey));

    expect(socket.closed?.code).toBe(1011);
    expect(socket.closed?.reason).toMatch(/decrypt/i);
    expect(seen).toHaveLength(0);

    // A closed session must not keep forwarding frames.
    socket.receive(sealText('after', hostKey));
    expect(seen).toHaveLength(0);
  });
});

describe('terminal websocket encryption switch', () => {
  it('wraps the socket when the relay host key was unlocked', () => {
    setHostKey('host-a', hostKey);

    const socket = openTerminalWebSocket('wss://relay.example.test/relay/host-a/api/pty/pty-1/connect', 'Bearer jwt') as unknown as FakeSocket;

    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.options).toEqual({ headers: { Authorization: 'Bearer jwt' } });

    socket.send('x');
    const plain = decryptFrame(socket.sent[0] as Uint8Array, hostKey);
    expect(plain[0]).toBe(1);
    expect(decoder.decode(plain.subarray(1))).toBe('x');
  });

  it('leaves the socket untouched when the passphrase was skipped', () => {
    const socket = openTerminalWebSocket('wss://relay.example.test/relay/host-a/api/pty/pty-1/connect') as unknown as FakeSocket;

    expect(socket.binaryType).toBe('blob');
    socket.send('x');
    expect(socket.sent).toEqual(['x']);
  });

  it('leaves direct connections untouched', () => {
    setHostKey('host-a', hostKey);

    const socket = openTerminalWebSocket('wss://direct.example.test/api/pty/pty-1/connect') as unknown as FakeSocket;

    expect(socket.binaryType).toBe('blob');
    socket.send('x');
    expect(socket.sent).toEqual(['x']);
  });
});
