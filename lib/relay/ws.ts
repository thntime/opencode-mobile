import { decryptFrame, encryptFrame } from './crypto';
import { RelayE2EError } from './errors';
import { getHostKeyForServerUrl } from './host-key-cache';

type MessageHandler = ((event: MessageEvent) => void) | null;
type MessageListener = (event: MessageEvent) => void;
// The encrypted socket is a single target with no capture phase, so `capture`
// is accepted for API compatibility but ignored; only `once` is honoured.
type MessageListenerEntry = { listener: MessageListener; once: boolean };
type NativeAddEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => void;
type NativeRemoveEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
) => void;

// Terminal frames are UTF-8 text (shell output and JSON control messages), and
// the renderer consumes strings. Decrypting to bytes alone would hand it an
// ArrayBuffer and show mojibake.
function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function bytesOf(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

// D10: with a host key, every terminal frame is a sealed `nonce || ciphertext ||
// tag`. The tunnel uses the same predicate (its local `EncryptionKey`), so
// "key present" is the only switch either side needs.
export function encryptTerminalSocket(socket: WebSocket, hostKey: Uint8Array): WebSocket {
  const nativeSend = socket.send.bind(socket);
  const nativeClose = socket.close.bind(socket);
  const nativeAdd = socket.addEventListener.bind(socket) as NativeAddEventListener;
  const nativeRemove = socket.removeEventListener.bind(socket) as NativeRemoveEventListener;
  let handler: MessageHandler = typeof socket.onmessage === 'function' ? socket.onmessage : null;
  // Consumers may register with `onmessage` or `addEventListener('message')`.
  // Both are intercepted and fed the decrypted event; the native socket keeps a
  // single internal listener so a later `addEventListener` cannot observe
  // ciphertext.
  const listeners = new Map<EventListenerOrEventListenerObject, MessageListenerEntry>();
  let closed = false;

  socket.binaryType = 'arraybuffer';

  // DOM EventTarget semantics: one throwing consumer must not stop the others
  // or close the socket. The error is re-thrown from a macrotask so it still
  // surfaces (as an unhandled error) instead of being swallowed.
  const isolate = (run: () => void) => {
    try {
      run();
    } catch (error) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  };

  const dispatch = (event: MessageEvent) => {
    if (closed) return;
    const current = handler;
    if (current) isolate(() => current(event));
    for (const [key, entry] of Array.from(listeners.entries())) {
      // A `once` listener is removed before it runs, matching the DOM.
      if (entry.once) listeners.delete(key);
      isolate(() => entry.listener(event));
    }
  };

  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    const reason = error instanceof Error ? error.message : 'E2E decryption failed.';
    // 1011 = internal error, matching the tunnel's close code for a frame it
    // could not decrypt.
    try {
      nativeClose(1011, reason.slice(0, 120));
    } catch {
      try {
        nativeClose();
      } catch {
        // The socket is already gone.
      }
    }
  };

  const deliver = (event: MessageEvent) => {
    if (closed) return;
    if (!handler && listeners.size === 0) return;

    try {
      const bytes = bytesOf(event.data);
      if (!bytes) throw new RelayE2EError('relay_e2e_decrypt_failed', 'Unsupported terminal frame.');
      // Ciphertext always travels as a binary frame (a text frame would be
      // UTF-8 decoded by the socket and the bytes would be lost). The plaintext
      // starts with the original opcode so text/binary survives the round trip.
      const plaintext = decryptFrame(bytes, hostKey);
      if (plaintext.length < 1) throw new RelayE2EError('relay_e2e_decrypt_failed', 'Empty terminal frame.');
      const opcode = plaintext[0];
      const payload = plaintext.subarray(1);
      const data = opcode === 1
        ? decodeUtf8(payload)
        : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      dispatch({ data } as unknown as MessageEvent);
    } catch (error) {
      fail(error);
    }
  };

  // `onmessage` is assigned after this wrapper returns, so the assignment is
  // captured here and the decryption listener stays attached to the native
  // socket.
  Object.defineProperty(socket, 'onmessage', {
    configurable: true,
    get: () => handler,
    set: (next) => {
      handler = typeof next === 'function' ? next : null;
    },
  });

  socket.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type !== 'message') {
      nativeAdd(type, listener, options);
      return;
    }
    if (!listener || listeners.has(listener)) return;
    // `options === true` is the legacy capture shorthand; both forms are
    // ignored here because the encrypted socket has no capture phase.
    const once = typeof options === 'object' && options !== null ? options.once === true : false;
    listeners.set(listener, {
      listener: typeof listener === 'function'
        ? listener as MessageListener
        : (event) => listener.handleEvent(event),
      once,
    });
  }) as WebSocket['addEventListener'];

  socket.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type !== 'message') {
      nativeRemove(type, listener, options);
      return;
    }
    listeners.delete(listener);
  }) as WebSocket['removeEventListener'];

  nativeAdd('message', deliver as EventListener);

  const seal = (bytes: Uint8Array, opcode: number) => {
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = opcode;
    framed.set(bytes, 1);
    return encryptFrame(framed, hostKey);
  };

  socket.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (closed) return;
    if (typeof data === 'string') {
      nativeSend(seal(new TextEncoder().encode(data), 1));
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer()
        .then((buffer) => {
          if (!closed) nativeSend(seal(new Uint8Array(buffer), 2));
        })
        .catch(fail);
      return;
    }
    const bytes = bytesOf(data);
    if (!bytes) throw new RelayE2EError('relay_e2e_unavailable', 'Unsupported terminal frame.');
    nativeSend(seal(bytes, 2));
  }) as WebSocket['send'];

  return socket;
}

// Convenience for the terminal service: resolve the key from the `/relay/{id}`
// prefix in the socket URL and wrap only when the user unlocked the host.
export function withRelayEncryption(socket: WebSocket, url: string): WebSocket {
  const hostKey = getHostKeyForServerUrl(url);
  return hostKey ? encryptTerminalSocket(socket, hostKey) : socket;
}
