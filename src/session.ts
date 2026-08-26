// Browser session cookies for /dashboard. HMAC-signed values, no server-side
// session state. The uid inside the cookie is the ONLY place the dashboard
// page takes identity from — never from the URL.

const SESSION_TTL_S = 30 * 24 * 3600; // 30 days
const LOGIN_STATE_TTL_S = 600; // login nonce validity

export const SESSION_COOKIE = "whoop_session";
export const LOGIN_COOKIE = "whoop_login";
// Browser-login OAuth states carry this prefix; MCP states are base64 JSON
// blobs from workers-oauth-provider and can never collide with it.
export const BROWSER_STATE_PREFIX = "b.";

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintSessionCookie(uid: number, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmac(secret, `session.${uid}.${exp}`);
  return `${uid}.${exp}.${sig}`;
}

export async function verifySessionCookie(value: string | null, secret: string): Promise<number | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [uidStr, expStr, sig] = parts as [string, string, string];
  const uid = Number(uidStr);
  const exp = Number(expStr);
  if (!Number.isInteger(uid) || !Number.isInteger(exp)) return null;
  if (exp * 1000 < Date.now()) return null;
  const expected = await hmac(secret, `session.${uidStr}.${expStr}`);
  return timingSafeEqual(sig, expected) ? uid : null;
}

// Login-CSRF protection: the OAuth state carries a signed nonce that must
// match the nonce cookie set when the login started (double submit).
export async function mintLoginState(secret: string): Promise<{ state: string; nonce: string }> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const exp = Math.floor(Date.now() / 1000) + LOGIN_STATE_TTL_S;
  const sig = await hmac(secret, `login.${nonce}.${exp}`);
  return { state: `${BROWSER_STATE_PREFIX}${nonce}.${exp}.${sig}`, nonce };
}

export async function verifyLoginState(
  state: string,
  cookieNonce: string | null,
  secret: string
): Promise<boolean> {
  if (!state.startsWith(BROWSER_STATE_PREFIX) || !cookieNonce) return false;
  const parts = state.slice(BROWSER_STATE_PREFIX.length).split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  if (!timingSafeEqual(nonce, cookieNonce)) return false;
  const expected = await hmac(secret, `login.${nonce}.${expStr}`);
  return timingSafeEqual(sig, expected);
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionSetCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}`;
}

export function loginSetCookie(nonce: string): string {
  return `${LOGIN_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${LOGIN_STATE_TTL_S}`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
