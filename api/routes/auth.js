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
  OAUTH_STATE_COOKIE,
} = require('../utils/session');
const config = require('../config');

const router = express.Router();

// GET /auth/discord — kicks off the OAuth2 flow.
router.get('/discord', (req, res) => {
  if (!config.discord.clientId || !config.discord.clientSecret || !config.discord.redirectUri) {
    return res
      .status(500)
      .json({ error: 'Discord login is niet geconfigureerd (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / PUBLIC_URL ontbreken).' });
  }

  const state = crypto.randomBytes(24).toString('base64url');
  setOAuthStateCookie(res, state);
  res.redirect(oauth.buildAuthorizeUrl(state));
});

// GET /auth/discord/callback — Discord redirects back here with a code.
router.get(
  '/discord/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/dashboard/?login_error=${encodeURIComponent(String(oauthError))}`);
    }

    const cookies = parseCookies(req);
    clearOAuthStateCookie(res);

    if (!code || !state || !cookies[OAUTH_STATE_COOKIE] || state !== cookies[OAUTH_STATE_COOKIE]) {
      return res.redirect('/dashboard/?login_error=invalid_state');
    }

    let tokenData;
    try {
      tokenData = await oauth.exchangeCode(String(code));
    } catch (err) {
      return res.redirect(`/dashboard/?login_error=${encodeURIComponent('token_exchange_failed')}`);
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

    res.redirect('/dashboard/');
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
