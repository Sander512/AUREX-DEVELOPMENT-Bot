// api/utils/discordOAuth.js
// Thin wrapper around Discord's OAuth2 endpoints for the "Login with
// Discord" dashboard flow. Only uses the `identify` and `guilds` scopes —
// enough to know who the user is and which servers they can manage.

const config = require('../config');

const DISCORD_API = 'https://discord.com/api/v10';

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });

  // Bij een 429 met "global rate limit" is Discord's hele API voor dit
  // IP-adres (tijdelijk) op slot — dat is geen probleem in onze eigen
  // configuratie en gaat vanzelf over. Eén korte herprobeerpoging vangt
  // een kortstondige piek op; bij een langduriger blokkade (grotere
  // retry_after) geven we het snel door in plaats van de loginpoging van
  // de gebruiker minutenlang te laten hangen.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    let retryAfterSeconds = null;
    try {
      retryAfterSeconds = JSON.parse(text)?.retry_after ?? null;
    } catch {
      // geen JSON-body — negeren
    }

    if (res.status === 429 && attempt === 0 && retryAfterSeconds !== null && retryAfterSeconds <= 3) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000 + 200));
      continue;
    }

    const err = new Error(`Discord token-uitwisseling mislukt (${res.status}): ${text}`);
    err.discordStatus = res.status;
    err.rateLimited = res.status === 429;
    throw err;
  }
}

async function fetchUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Kon Discord-gebruiker niet ophalen (${res.status})`);
  return res.json();
}

async function fetchUserGuilds(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Kon Discord-servers niet ophalen (${res.status})`);
  return res.json();
}

// True if this Discord user can manage the given guild (owner, or has the
// Administrator / Manage Server permission) — i.e. someone who should be
// allowed to configure the bot there.
function canManageGuild(guild) {
  if (guild.owner) return true;
  try {
    const perms = BigInt(guild.permissions);
    return (perms & ADMINISTRATOR) === ADMINISTRATOR || (perms & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUser,
  fetchUserGuilds,
  canManageGuild,
};
