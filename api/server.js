// api/server.js
// Aurex | Development API — Express server.
// Handles the dashboard login, ticket panel, welcome messages, verify
// panel and rules system for the Discord bot.

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const ticketsRoutes = require('./routes/tickets');
const welcomeRoutes = require('./routes/welcome');
const verifyRoutes = require('./routes/verify');
const rulesRoutes = require('./routes/rules');
const authRoutes = require('./routes/auth');
const discordGuildsRoutes = require('./routes/discordGuilds');
const storeRoutes = require('./routes/store');
const stripeWebhookHandler = require('./routes/storeWebhook');
const { initDb } = require('./database');
const config = require('./config');
const { requireApiKey } = require('./middleware/auth');

const API_KEY = config.apiKey;
// Render (and most PaaS providers) assign the port dynamically via PORT.
// Falls back to API_PORT for local development.
const PORT = parseInt(process.env.PORT, 10) || parseInt(process.env.API_PORT, 10) || 3000;

if (!API_KEY) {
  console.error('[FATAL] API_KEY is niet ingesteld in .env — de server start niet zonder deze secret.');
  process.exit(1);
}

if (!config.session.secret) {
  console.error('[FATAL] SESSION_SECRET is niet ingesteld in .env — nodig om dashboard-logins veilig te ondertekenen.');
  process.exit(1);
}

if (!config.discord.clientId || !config.discord.clientSecret) {
  console.warn(
    '[CONFIG WARNING] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET ontbreken — "Inloggen met Discord" op het dashboard werkt dan niet.'
  );
} else {
  // Handig om te vergelijken met de "Omleidingen" (redirects) in de Discord
  // Developer Portal (OAuth2-tab) — moet daar EXACT (incl. https://, geen
  // trailing slash) als redirect-URI geregistreerd staan, anders weigert
  // Discord de login met "invalid_client"/"redirect_uri mismatch".
  console.log(`[AUTH] Discord OAuth redirect-URI: ${config.discord.redirectUri || '(niet ingesteld — PUBLIC_URL ontbreekt)'}`);
}

if (!config.stripe.secretKey || !config.stripe.webhookSecret) {
  console.warn(
    '[CONFIG WARNING] STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET ontbreken — de webshop-checkout en betaalbevestiging werken dan niet.'
  );
}

const app = express();

const path = require('path');

// Resolved once the API is actually listening on PORT (after initDb()).
// start.js awaits this before logging the bot in, so the bot never tries
// to sync its guild list to an API that isn't up yet (the cause of
// "fetch failed" / ECONNREFUSED on localhost right after boot).
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));

// ---- CORS voor de los gehoste webshop (bv. Vercel) ----
// Alleen de ene geconfigureerde SHOP_ORIGIN mag credentials:'include'
// requests doen — nooit '*', want dat is niet toegestaan samen met
// cookies en zou ook elke willekeurige site de sessie laten gebruiken.
// Zonder SHOP_ORIGIN gebeurt er niets: dan blijft alles same-origin.
if (config.shopOrigin) {
  app.use((req, res, next) => {
    if (req.headers.origin === config.shopOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.shopOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
}

// MUST be mounted before express.json(): Stripe's signature check needs
// the raw, untouched request body. Once express.json() below has parsed
// a request, that raw body is gone — so this route can never move under
// the regular /store router (which uses express.json() like every other
// route here).
app.post('/store/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Bestandsupload (base64 in JSON) heeft een grotere limiet nodig dan de rest.
// Moet VÓÓR de globale express.json() staan; body-parser slaat een al
// geparste body daarna over.
// 1 GB bestand wordt ~1,37 GB als base64 in de JSON-body — ruim marge aanhouden.
app.use('/store/admin/product-file', express.json({ limit: '1500mb' }));

app.use(express.json({ limit: '100kb' }));

// ---- Global rate limiting ----
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
  })
);

// ---- Uptime check ----
// Simpele root route zodat UptimeRobot (of vergelijkbare monitors) via een
// GET- of HEAD-request kan controleren of de Render-server online is.
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.head('/', (req, res) => {
  res.status(200).end();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Ticket routes have mixed auth: bot-only endpoints require X-API-Key,
// dashboard-facing endpoints accept either X-API-Key or a Discord-login
// session scoped to that guild — see the per-route middleware inside
// routes/tickets.js. Same pattern for welcome, verify and rules.
app.use('/tickets', ticketsRoutes);
app.use('/welcome', welcomeRoutes);
app.use('/verify', verifyRoutes);
app.use('/rules', rulesRoutes);
// Publieke productenlijst + checkout leven hier ook al onder /store (het
// hierboven gemounte /store/webhook is de enige uitzondering die apart
// staat, om de raw-body reden hierboven).
app.use('/store', storeRoutes);

// ---- Dashboard login ("Inloggen met Discord") ----
// No requireApiKey here — this is what lets the browser authenticate
// without ever holding the API key.
app.use('/auth', authRoutes);

// ---- Bot -> API sync of which Discord servers the bot is currently in ----
app.use('/discord-guilds', requireApiKey, discordGuildsRoutes);

// ---- Dashboard (static; the page itself authenticates via the
// httpOnly session cookie set by /auth, not a key typed into the UI) ----
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));

// De webshop-pagina zelf staat NIET meer in dit project: die is een los
// project (map shop-site/) dat apart op bv. Vercel draait en via
// SHOP_ORIGIN + CORS met deze API praat.

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Global error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[API ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

(async () => {
  try {
    await initDb();
    console.log('[API] Database schema geïnitialiseerd.');
  } catch (err) {
    console.error('[FATAL] Kon database niet initialiseren:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[API] Aurex | Development API luistert op poort ${PORT}`);
    resolveReady();
  });
})();

module.exports = { app, ready };
