// The Relay account password exists only for the lifetime of the process. It is
// needed to re-run `POST /api/login` when the JWT expires (the Relay has no
// refresh-token endpoint), so it is cached in memory after a successful
// sign-in. It is deliberately never written to SecureStore/AsyncStorage: a
// relaunch must fall back to `needsReauth` and ask the user to sign in again.
let password: string | undefined;

export function setRelaySessionPassword(value: string | undefined) {
  // The password is deliberately kept untrimmed: surrounding whitespace can be
  // part of the credential. The trimmed copy only decides whether it is empty.
  password = value && value.trim() ? value : undefined;
}

export function getRelaySessionPassword() {
  return password;
}

export function clearRelaySessionPassword() {
  password = undefined;
}
