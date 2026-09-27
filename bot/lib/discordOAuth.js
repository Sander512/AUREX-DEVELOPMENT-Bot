// lib/discordOAuth.js
// Thin wrapper around Discord's OAuth2 endpoints for the "Login with
// Discord" dashboard flow — same approach as the Forever RP project.
//
// Only the `identify` scope is requested. Unlike Forever RP, this
// dashboard does NOT need the user's own `guilds` list: guild access is
// resolved separately via the bot's own token (see lib/discord.js +
// lib/permissions.js), which doubles as the "is the bot even in this
// server" check.

const DISCORD_API = "https://discord.com/api/v10";

/**
 * The redirect URI Discord sends the user back to after login. Prefer an
 * explicit DISCORD_REDIRECT_URI (useful for a custom domain); otherwise
 * derive it from NEXTAUTH_URL / RENDER_EXTERNAL_URL, same fallback Render
 * needs elsewhere in this app. Points at /api/auth/discord itself — the
 * same route also handles the callback, so there's no separate
 * /callback path (and thus no extra nested folder to upload to GitHub).
 */
function getRedirectUri() {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;

  const base = process.env.NEXTAUTH_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) return null;

  return `${base.replace(/\/+$/, "")}/api/auth/discord`;
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord token-uitwisseling mislukt (${res.status}): ${text}`);
  }

  return res.json();
}

async function fetchUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Kon Discord-gebruiker niet ophalen (${res.status})`);
  return res.json();
}

module.exports = { getRedirectUri, buildAuthorizeUrl, exchangeCode, fetchUser };
