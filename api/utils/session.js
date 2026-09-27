// api/utils/session.js
// Minimal signed-cookie sessions for the dashboard login, built on Node's
// built-in crypto so we don't need extra dependencies (express-session,
// jsonwebtoken, ...) for something this small.
//
// The cookie holds a base64url JSON payload plus an HMAC-SHA256 signature:
//   <payload>.<signature>
// It is NOT encrypted — anyone holding the cookie can read the payload —
// so only non-secret data (Discord user id/username/avatar, the guilds
// they manage) goes in it. It IS tamper-proof: the signature is verified
// with a server-side secret before the payload is ever trusted.

const crypto = require('crypto');
const config = require('../config');

const SESSION_COOKIE = 'frp_session';
const OAUTH_STATE_COOKIE = 'frp_oauth_state';

function sign(payload, maxAgeMs) {
  const data = { ...payload, exp: Date.now() + maxAgeMs };
  const body = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.session.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;

  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', config.session.secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;

  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  });

  return out;
}

// Reads and verifies the session cookie off a request. Returns the
// session payload (discordId, username, avatar, guilds[]) or null.
function getSessionUser(req) {
  const cookies = parseCookies(req);
  return verify(cookies[SESSION_COOKIE]);
}

function setCookie(res, name, value, maxAgeMs, { httpOnly = true } = {}) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1000));
  const httpOnlyPart = httpOnly ? ' HttpOnly;' : '';
  const cookie = `${name}=${encodeURIComponent(value)};${httpOnlyPart}${secure} Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  const next = existing ? [].concat(existing, cookie) : cookie;
  res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

function setSessionCookie(res, payload, maxAgeMs = config.session.maxAgeMs) {
  setCookie(res, SESSION_COOKIE, sign(payload, maxAgeMs), maxAgeMs);
}

function clearSessionCookie(res) {
  clearCookie(res, SESSION_COOKIE);
}

// Short-lived cookie used only to defend the OAuth redirect against CSRF
// (the `state` param must round-trip through the user's own browser).
function setOAuthStateCookie(res, state) {
  setCookie(res, OAUTH_STATE_COOKIE, state, 5 * 60 * 1000);
}

function clearOAuthStateCookie(res) {
  clearCookie(res, OAUTH_STATE_COOKIE);
}

module.exports = {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  parseCookies,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  clearOAuthStateCookie,
};
