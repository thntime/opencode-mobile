// The E2E passphrase lives in memory for the lifetime of the process only.
// Writing it to SecureStore/AsyncStorage would make a stolen device decrypt the
// host traffic, so killing the app (or logging out) must drop it.
let passphrase: string | undefined;

export function setPassphrase(value: string) {
  passphrase = value.length > 0 ? value : undefined;
}

export function getPassphrase() {
  return passphrase;
}

export function clearPassphrase() {
  passphrase = undefined;
}
