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

  // Webshop — echte betalingen via Stripe Checkout. Alle drie komen uit
  // je Stripe dashboard (Developers > API keys, en Developers > Webhooks
  // voor de signing secret nadat je het webhook-endpoint hebt aangemaakt).
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  },

  // Zet dit als de shop-pagina (public/shop) LOS van deze API gedeployed
  // wordt (bv. op Vercel, terwijl bot+API op Render blijven). Geen
  // trailing slash, bv. https://aurex-shop.vercel.app. Nodig voor CORS
  // (welke origin mag credentials:'include' fetches doen) en om na
  // Discord-login veilig terug te sturen naar dat domein (zie auth.js —
  // alleen een return-URL die exact op dit domein uitkomt wordt
  // vertrouwd, ter voorkoming van open-redirect misbruik).
  // Laat leeg als de shop gewoon op hetzelfde domein blijft (/shop).
  // Standaard server voor de shop (zodat de shop-link geen ?guild= nodig
  // heeft) en de Discord-uitnodigingslink voor de "Join Discord"-knop.
  shopGuildId: process.env.SHOP_GUILD_ID || process.env.DISCORD_GUILD_ID || null,
  discordInviteUrl: process.env.DISCORD_INVITE_URL || null,

  shopOrigin: process.env.SHOP_ORIGIN ? process.env.SHOP_ORIGIN.replace(/\/$/, '') : null,
};

module.exports = config;
