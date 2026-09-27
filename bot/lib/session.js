// lib/session.js
// Minimal signed-cookie sessions for the dashboard login, built on Node's
// built-in crypto — same approach as the Forever RP project, ported to
// Next.js (App Router). No external session library, no NextAuth.
//
// The cookie holds a base64url JSON payload plus an HMAC-SHA256 signature:
//   <payload>.<signature>
// It is NOT encrypted — anyone holding the cookie can read the payload —
// so only non-secret data (Discord user id/username/avatar) goes in it.
// It IS tamper-proof: the signature is verified with a server-side secret
// (NEXTAUTH_SECRET) before the payload is ever trusted.

const crypto = require("crypto");

const SESSION_COOKIE = "aurex_session";
const OAUTH_STATE_COOKIE = "aurex_oauth_state";
const CALLBACK_COOKIE = "aurex_callback_url";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET ontbreekt — nodig om sessies te ondertekenen.");
  }
  return secret;
}

function sign(payload, maxAgeMs = MAX_AGE_MS) {
  const data = { ...payload, exp: Date.now() + maxAgeMs };
  const body = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expectedSig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}

/**
 * Reads and verifies the session cookie. Accepts anything with a `.get(name)`
 * method that returns either a string or a `{ value }` object — this covers
 * both `cookies()` from `next/headers` (Server Components, Server Actions)
 * and `request.cookies` on a `NextRequest` (Route Handlers), so the same
 * helper works everywhere in the app.
 */
function getSessionUser(cookieStore) {
  const raw = cookieStore.get(SESSION_COOKIE);
  const token = typeof raw === "string" ? raw : raw?.value;
  return verify(token);
}

module.exports = {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  CALLBACK_COOKIE,
  MAX_AGE_MS,
  sign,
  verify,
  getSessionUser,
};
