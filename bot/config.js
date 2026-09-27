// bot/config.js
// Central configuration loaded from environment variables.
// Never hardcode secrets here — everything comes from .env

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.warn(`[CONFIG WARNING] Missing environment variable: ${name}`);
  }
  return value;
}

const config = {
  brand: {
    name: 'Aurex | Development',
    activity: 'Aurex | Development',
  },

  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: required('DISCORD_GUILD_ID'),
  },

  api: {
    // When bot + API run in the same process (start.js, e.g. on Render),
    // the API always binds to process.env.PORT (or API_PORT as fallback).
    // Default to that same port automatically so the bot never has to
    // guess/hardcode a port that doesn't match what the API actually bound to.
    // Set API_BASE_URL explicitly only if the API runs as a SEPARATE service
    // (e.g. bot and API deployed independently, or a custom domain).
    baseUrl:
      process.env.API_BASE_URL ||
      `http://localhost:${process.env.PORT || process.env.API_PORT || 3000}`,
    key: required('API_KEY'),
    port: parseInt(process.env.API_PORT, 10) || 3000,
  },

  database: {
    path: process.env.DATABASE_PATH || './data/aurex.sqlite',
  },

  roles: {
    staffRoleId: process.env.STAFF_ROLE_ID || null,
    managementRoleId: process.env.MANAGEMENT_ROLE_ID || null,
    auditLogChannelId: process.env.AUDIT_LOG_CHANNEL_ID || null,
  },

  // Colors used across embeds — matches Aurex | Development branding
  colors: {
    primary: 0x5865f2, // Discord blurple / brand primary
    success: 0x10b981, // Green
    error: 0xef4444,
    warning: 0xf59e0b,
    info: 0x3b82f6,
  },
};

module.exports = config;
