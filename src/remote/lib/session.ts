/** Device session storage (bearer token lives only on this device). */

const TOKEN_KEY = "kern.token";

let token = localStorage.getItem(TOKEN_KEY) ?? "";

export function getToken(): string {
  return token;
}

export function setSession(next: string): void {
  token = next;
  localStorage.setItem(TOKEN_KEY, next);
}

export function clearSession(): void {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
}

/** Human label for this device, shown in the desktop's device list. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios device";
  if (/Android/.test(ua)) return "android device";
  if (/Macintosh/.test(ua)) return "mac browser";
  if (/Windows/.test(ua)) return "windows browser";
  if (/Linux/.test(ua)) return "linux browser";
  return "browser";
}

/** One-shot legacy pairing: `?token=` from the desktop's owner QR code. */
export function consumeLegacyToken(): void {
  const params = new URLSearchParams(location.search);
  const legacy = params.get("token");
  if (legacy) {
    setSession(legacy);
    history.replaceState(null, "", location.pathname);
  }
}
