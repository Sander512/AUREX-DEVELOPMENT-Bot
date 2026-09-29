// api/routes/auth.js
// "Login with Discord" for the dashboard. No passwords, no API keys typed
// into a browser — the dashboard only ever gets a signed, httpOnly
// session cookie scoped to the servers this Discord user actually
// manages (and that the bot is actually in).

const crypto = require('crypto');
const express = require('express');
const { db } = require('../database');
const oauth = require('../utils/discordOAuth');
const asyncHandler = require('../utils/asyncHandler');
const {
  parseCookies,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  clearOAuthStateCookie,
  setOAuthReturnCookie,
  getOAuthReturnCookie,
  clearOAuthReturnCookie,
  OAUTH_STATE_COOKIE,
} = require('../utils/session');
const config = require('../config');

const router = express.Router();

// Bepaalt waar de callback straks naar teruglinkt. Standaard 'dashboard'
// (zelfde-origin, relatief pad). Voor de shop: als de shop op een ANDER
// domein draait (bv. Vercel, via SHOP_ORIGIN in .env), moet dat een
// absolute URL zijn — maar nooit een ongevalideerde, want anders kan
// iemand een phishing-link maken die na een echte Discord-login naar een
// willekeurige site doorstuurt (open redirect). Alleen een return-URL
// waarvan de origin exact overeenkomt met de geconfigureerde SHOP_ORIGIN
// wordt vertrouwd; anders valt dit terug op de eigen /shop/ pagina
// (zelfde-origin, alleen relevant als shop en API op hetzelfde domein
// draaien) of simpelweg de kale SHOP_ORIGIN-root.
function resolveReturnTarget(req) {
  if (req.query.from !== 'shop') return 'dashboard';

  const requested = req.query.return;
  if (requested && config.shopOrigin) {
    try {
      if (new URL(String(requested)).origin === new URL(config.shopOrigin).origin) {
        return String(requested);
      }
    } catch {
      // Geen geldige URL — negeren en op de fallbacks hieronder terugvallen.
    }
  }

  return config.shopOrigin || 'shop';
}

// Bouwt de uiteindelijke redirect-URL voor een return-target zoals
// hierboven, met een paar query-params erbij (bv. login_error).
function buildRedirectUrl(returnTarget, queryParams) {
  const qs = new URLSearchParams(queryParams).toString();

  if (returnTarget === 'dashboard' || returnTarget === 'shop') {
    return `/${returnTarget}/${qs ? `?${qs}` : ''}`;
  }

  // Absolute URL (SHOP_ORIGIN, met of zonder specifiek pad erbij).
  const url = new URL(returnTarget);
  for (const [key, value] of new URLSearchParams(qs)) url.searchParams.set(key, value);
  return url.toString();
}

// GET /auth/discord — kicks off the OAuth2 flow.
router.get('/discord', (req, res) => {
  if (!config.discord.clientId || !config.discord.clientSecret || !config.discord.redirectUri) {
    return res
      .status(500)
      .json({ error: 'Discord login is niet geconfigureerd (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / PUBLIC_URL ontbreken).' });
  }

  const state = crypto.randomBytes(24).toString('base64url');
  setOAuthStateCookie(res, state);
  setOAuthReturnCookie(res, resolveReturnTarget(req));
  res.redirect(oauth.buildAuthorizeUrl(state));
});

// GET /auth/discord/callback — Discord redirects back here with a code.
router.get(
  '/discord/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    const returnTo = getOAuthReturnCookie(req);
    clearOAuthReturnCookie(res);

    if (oauthError) {
      return res.redirect(buildRedirectUrl(returnTo, { login_error: String(oauthError) }));
    }

    const cookies = parseCookies(req);
    clearOAuthStateCookie(res);

    if (!code || !state || !cookies[OAUTH_STATE_COOKIE] || state !== cookies[OAUTH_STATE_COOKIE]) {
      console.error(
        `[AUTH] Ongeldige state: code=${!!code} state=${!!state} stateCookie=${!!cookies[OAUTH_STATE_COOKIE]} match=${state === cookies[OAUTH_STATE_COOKIE]}`
      );
      return res.redirect(buildRedirectUrl(returnTo, { login_error: 'invalid_state' }));
    }

    let tokenData;
    try {
      tokenData = await oauth.exchangeCode(String(code));
    } catch (err) {
      console.error('[AUTH] Discord token-uitwisseling mislukt:', err.message);
      const errorCode = err.rateLimited ? 'rate_limited' : 'token_exchange_failed';
      return res.redirect(buildRedirectUrl(returnTo, { login_error: errorCode }));
    }

    const [discordUser, discordGuilds] = await Promise.all([
      oauth.fetchUser(tokenData.access_token),
      oauth.fetchUserGuilds(tokenData.access_token),
    ]);

    // Only keep guilds the user can actually manage AND the bot is in —
    // this is the whole "waar deze bot in zit" list, scoped to this user.
    const manageable = discordGuilds.filter(oauth.canManageGuild).map((g) => String(g.id));

    let botGuildRows = [];
    if (manageable.length > 0) {
      const placeholders = manageable.map(() => '?').join(', ');
      const result = await db.execute({
        sql: `SELECT guild_id, name, icon FROM discord_guilds WHERE guild_id IN (${placeholders})`,
        args: manageable,
      });
      botGuildRows = result.rows;
    }

    const guilds = botGuildRows.map((row) => ({
      id: row.guild_id,
      name: row.name,
      icon: row.icon || null,
    }));

    setSessionCookie(res, {
      discordId: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar || null,
      guilds,
    });

    res.redirect(buildRedirectUrl(returnTo, {}));
  })
);

// GET /auth/me — who's currently logged in, and which servers they can manage.
router.get('/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  res.json({
    discordId: user.discordId,
    username: user.username,
    avatar: user.avatar,
    guilds: user.guilds || [],
  });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

module.exports = router;
