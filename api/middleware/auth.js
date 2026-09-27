// api/middleware/auth.js
// Two independent ways to authenticate against the API:
//
//   1. X-API-Key  — the shared secret the bot uses. Full
//      access, never seen by a browser.
//   2. Dashboard session cookie — set after "Login with Discord". Scoped:
//      it only grants access to the specific guild(s) that Discord user
//      is allowed to manage AND that the bot is actually in.

const config = require('../config');
const { getSessionUser } = require('../utils/session');

function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key');
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
  }
  next();
}

function requireSession(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: log in met Discord' });
  req.user = user;
  next();
}

function extractGuildId(req) {
  return (req.params && req.params.guildId) || (req.body && req.body.guildId) || null;
}

function requireGuildAccess(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: log in met Discord' });

  const guildId = extractGuildId(req);
  const allowed = Array.isArray(user.guilds) && user.guilds.some((g) => g.id === guildId);
  if (!guildId || !allowed) {
    return res.status(403).json({ error: 'Je hebt geen toegang tot deze server' });
  }

  req.user = user;
  next();
}

// Routes the browser dashboard calls directly: accept the bot's
// X-API-Key (full trust) OR a dashboard session scoped to the guild in
// the request. This is what lets the dashboard drop the raw API key
// entirely and rely on "Login with Discord" instead.
function requireApiKeyOrGuildAccess(req, res, next) {
  const key = req.header('X-API-Key');
  if (key && key === config.apiKey) return next();
  return requireGuildAccess(req, res, next);
}

module.exports = {
  requireApiKey,
  requireSession,
  requireGuildAccess,
  requireApiKeyOrGuildAccess,
};
