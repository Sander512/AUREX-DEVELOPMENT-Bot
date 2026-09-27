// api/config.js
// Central configuration for the API process, loaded from environment
// variables. Mirrors the style of bot/config.js.

require('dotenv').config();

// Base public URL of the deployed API (e.g. https://jouw-app.onrender.com).
// Used to build the Discord OAuth redirect URI automatically. Set
// DISCORD_REDIRECT_URI directly instead if you need something custom.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const config = {
  // Shared secret the bot uses to talk to the API — never
  // exposed to the browser.
  apiKey: process.env.API_KEY,

  publicUrl: PUBLIC_URL,

  session: {
    secret: process.env.SESSION_SECRET,
    // How long a dashboard login stays valid before you need to log in
    // with Discord again.
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  },

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI || (PUBLIC_URL ? `${PUBLIC_URL}/auth/discord/callback` : ''),
  },
};

module.exports = config;
