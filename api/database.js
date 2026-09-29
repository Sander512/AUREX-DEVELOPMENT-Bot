// api/database.js
//
// Uses @libsql/client, which speaks the same SQL dialect as SQLite but can
// connect to either:
//   1. Turso (a free, hosted SQLite-compatible database) — set
//      TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Data survives redeploys on
//      hosts like Render without needing a paid Persistent Disk, because
//      the database lives on Turso's servers, not on Render's filesystem.
//   2. A local file — used automatically when TURSO_DATABASE_URL is not
//      set, for local development. Same code, same queries, either way.

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const url = process.env.TURSO_DATABASE_URL || `file:${process.env.DATABASE_PATH || './data/aurex.sqlite'}`;
const authToken = process.env.TURSO_AUTH_TOKEN; // not used/needed in local file mode

// In local file mode, make sure the containing directory exists —
// libSQL (unlike better-sqlite3) does not create it automatically.
if (url.startsWith('file:')) {
  const filePath = url.slice('file:'.length);
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const db = createClient(authToken ? { url, authToken } : { url });

const SCHEMA = `
-- Kleine key/value-tabel voor interne instellingen die geen eigen tabel
-- verdienen — bv. onthouden welke slash-commands er al bij Discord
-- geregistreerd staan, zodat we dat niet op ELKE herstart hoeven te
-- herhalen (Discord's API rate-limit je sneller dan je denkt als je bij
-- elke deploy opnieuw alle commands pusht).
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  discord_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

-- ---- Discord guilds the bot is in ----
-- Kept in sync by the bot itself (on ready + guildCreate/guildDelete) via
-- authenticated API calls. The dashboard's "kies een server" screen cross-
-- references this against the guilds the logged-in Discord user can
-- manage, so it only ever shows servers that are BOTH bot-joined AND
-- theirs to configure.
CREATE TABLE IF NOT EXISTS discord_guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  updated_at INTEGER NOT NULL
);

-- ---- Ticket panel system ----
CREATE TABLE IF NOT EXISTS ticket_config (
  guild_id TEXT PRIMARY KEY,
  panel_title TEXT NOT NULL DEFAULT 'Support Tickets',
  panel_description TEXT NOT NULL DEFAULT 'Klik hieronder op het onderwerp dat het beste past om een ticket te openen.',
  panel_color TEXT NOT NULL DEFAULT '5865f2',
  panel_image TEXT,
  panel_thumbnail TEXT,
  panel_footer TEXT,
  category_id TEXT,
  log_channel_id TEXT,
  transcript_channel_id TEXT,
  support_role_id TEXT,
  name_format TEXT NOT NULL DEFAULT 'ticket-{number}',
  welcome_message TEXT NOT NULL DEFAULT 'Bedankt voor je ticket, {user}! Beschrijf je vraag of bestelling zo duidelijk mogelijk — het team helpt je zo snel mogelijk.',
  max_open_per_user INTEGER NOT NULL DEFAULT 1,
  require_close_reason INTEGER NOT NULL DEFAULT 0,
  ping_support_role INTEGER NOT NULL DEFAULT 1,
  show_ticket_info INTEGER NOT NULL DEFAULT 1,
  ticket_counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The individual buttons/options a user can pick from the panel's select
-- menu. Each type can override the category/role/naming/welcome message
-- from ticket_config, so different ticket types can behave differently
-- (bv. "Bestelling", "Support", "Klacht").
CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  category_id TEXT,
  support_role_id TEXT,
  name_format TEXT,
  welcome_message TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  claim_enabled INTEGER NOT NULL DEFAULT 1,
  close_enabled INTEGER NOT NULL DEFAULT 1,
  ask_description INTEGER NOT NULL DEFAULT 1,
  max_open_override INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(guild_id, key)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT UNIQUE NOT NULL,
  opener_id TEXT NOT NULL,
  type_key TEXT,
  type_label TEXT,
  ticket_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  close_reason TEXT,
  closed_by TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

-- ---- Welcome messages ----
CREATE TABLE IF NOT EXISTS welcome_config (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  content TEXT DEFAULT 'Welkom {user}! 🎉',
  embed_enabled INTEGER NOT NULL DEFAULT 1,
  embed_title TEXT DEFAULT 'Welkom bij Aurex | Development!',
  embed_description TEXT DEFAULT '{user} is zojuist lid geworden. We zijn nu met **{membercount}** leden!',
  embed_color TEXT NOT NULL DEFAULT '5865f2',
  embed_image TEXT,
  embed_footer TEXT DEFAULT '© Aurex | Development',
  use_avatar_thumbnail INTEGER NOT NULL DEFAULT 1,
  auto_role_id TEXT,
  dm_enabled INTEGER NOT NULL DEFAULT 0,
  dm_message TEXT DEFAULT 'Welkom bij Aurex | Development, {username}! Fijn dat je er bent.',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---- Verificatiesysteem ----
-- Eén rij per server: het verify-paneel (knop) kent geen code of externe
-- koppeling meer — een klik op de knop kent direct de ingestelde rol toe.
-- Volledig configureerbaar via het dashboard.
CREATE TABLE IF NOT EXISTS verify_config (
  guild_id TEXT PRIMARY KEY,
  role_id TEXT,
  role_ids TEXT,
  panel_title TEXT NOT NULL DEFAULT '🔐 Verifieer jezelf',
  panel_description TEXT NOT NULL DEFAULT 'Klik op de knop hieronder om jezelf te verifiëren en toegang te krijgen tot de server.',
  panel_color TEXT NOT NULL DEFAULT '5865f2',
  panel_image TEXT,
  panel_footer TEXT,
  button_label TEXT NOT NULL DEFAULT 'Verifiëren',
  log_channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---- Regels ----
CREATE TABLE IF NOT EXISTS rules_config (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT,
  title TEXT NOT NULL DEFAULT '📜 Server Regels',
  description TEXT NOT NULL DEFAULT '1️⃣ Wees respectvol naar iedereen.
2️⃣ Geen spam, reclame of NSFW-content.
3️⃣ Volg de Discord Richtlijnen.
4️⃣ Luister naar het team.',
  color TEXT NOT NULL DEFAULT '5865f2',
  image TEXT,
  footer TEXT DEFAULT '© Aurex | Development',
  message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_types_guild ON ticket_types(guild_id, position);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_opener_status ON tickets(opener_id, status);

-- ---- Webshop ----
-- Eén rij per verkoopbaar product. Bewust per guild_id geschaald, net als
-- alle andere features hier, zodat dezelfde structuur meerdere servers
-- kan bedienen als dat ooit nodig is.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  version TEXT,
  changelog TEXT,
  category TEXT,
  image_urls TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Eén rij per checkout-poging. Begint als 'pending' zodra de Stripe
-- Checkout Session wordt aangemaakt, en wordt pas 'completed' door de
-- webhook (nooit door de browser zelf — anders kan iemand een aankoop
-- vervalsen door gewoon naar de success-URL te surfen zonder te betalen).
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  discord_username TEXT,
  stripe_session_id TEXT UNIQUE,
  order_id TEXT,
  stripe_payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  purchased_at INTEGER
);

-- Wachtrij voor DM's die de bot moet versturen. De API (die geen eigen
-- Discord-verbinding heeft) zet hier rijen in; de bot pollt dit periodiek
-- leeg. Zo blijft "bot praat met API, nooit andersom" overeind, ook als
-- bot en API ooit als aparte services draaien.
CREATE TABLE IF NOT EXISTS pending_dms (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  embed_title TEXT NOT NULL,
  embed_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

-- Het bestand dat een koper na betaling (of bij een gratis product direct)
-- per DM ontvangt. Eén bestand per product; in de database opgeslagen zodat
-- het ook na een herstart/redeploy op Render nog bestaat.
CREATE TABLE IF NOT EXISTS product_files (
  product_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Eén kanaal per server waar automatisch een overzicht komt te staan van
-- alle producten die momenteel in de webshop staan (via /product kanaal).
-- dirty=1 betekent: het aanbod is veranderd sinds de laatste keer dat de
-- bot het bericht in dat kanaal heeft bijgewerkt.
CREATE TABLE IF NOT EXISTS product_channel_config (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_guild ON products(guild_id, active);
CREATE INDEX IF NOT EXISTS idx_purchases_product_status ON purchases(product_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_discord_guild ON purchases(discord_id, guild_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_dms_status ON pending_dms(status, created_at);
`;

// Columns added after the initial release. CREATE TABLE IF NOT EXISTS does
// not retrofit existing tables, so on every boot we make sure these exist
// too — each ALTER is wrapped so an "already exists" error (fresh installs
// that already have the column via SCHEMA above) is silently ignored.
const MIGRATIONS = [
  `ALTER TABLE ticket_types ADD COLUMN claim_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ticket_types ADD COLUMN close_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ticket_types ADD COLUMN ask_description INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ticket_types ADD COLUMN max_open_override INTEGER`,
  `ALTER TABLE ticket_config ADD COLUMN show_ticket_info INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tickets ADD COLUMN type_key TEXT`,
  `ALTER TABLE tickets ADD COLUMN type_label TEXT`,
  `ALTER TABLE tickets ADD COLUMN ticket_number INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tickets ADD COLUMN claimed_by TEXT`,
  `ALTER TABLE tickets ADD COLUMN close_reason TEXT`,
  `ALTER TABLE tickets ADD COLUMN closed_by TEXT`,
  `ALTER TABLE tickets ADD COLUMN closed_at INTEGER`,
  `ALTER TABLE welcome_config ADD COLUMN dm_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE welcome_config ADD COLUMN dm_message TEXT DEFAULT 'Welkom bij Aurex | Development, {username}! Fijn dat je er bent.'`,
  `ALTER TABLE rules_config ADD COLUMN message_id TEXT`,
  // Verify-rol werd één losse role_id; nu een JSON-array role_ids zodat
  // verificatie meerdere rollen tegelijk kan toekennen. role_id blijft
  // staan (niet meer gebruikt) zodat oude rijen niets kwijtraken.
  `ALTER TABLE verify_config ADD COLUMN role_ids TEXT`,
  // Winkelwagen: meerdere producten in één bestelling delen een order_id.
  `ALTER TABLE purchases ADD COLUMN order_id TEXT`,
  // Webshop-uiterlijk: categorie en productfoto's (JSON-array van URL's).
  `ALTER TABLE products ADD COLUMN category TEXT`,
  `ALTER TABLE products ADD COLUMN image_urls TEXT`,
  // Welke product-bestanden er bij een DM meegestuurd moeten worden (JSON-array van product-id's).
  `ALTER TABLE pending_dms ADD COLUMN file_product_ids TEXT`,
];

// One-time data migration: existing rows only have the old single
// role_id filled in — copy that into the new role_ids array the first
// time this runs, so nobody's existing verify-rol config silently
// disappears after the update. Guarded so it never overwrites a row
// that already has role_ids set (e.g. someone already configured
// multiple roles via the dashboard).
const ROLE_IDS_BACKFILL = `
  UPDATE verify_config
  SET role_ids = '["' || role_id || '"]'
  WHERE role_id IS NOT NULL
    AND TRIM(role_id) != ''
    AND (role_ids IS NULL OR TRIM(role_ids) = '')
`;

async function initDb() {
  await db.executeMultiple(SCHEMA);

  for (const sql of MIGRATIONS) {
    try {
      await db.execute({ sql, args: [] });
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

  await db.execute({ sql: ROLE_IDS_BACKFILL, args: [] });
}

async function getSetting(key) {
  const r = await db.execute({ sql: 'SELECT value FROM bot_settings WHERE key = ?', args: [key] });
  return r.rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await db.execute({
    sql: `INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, Date.now()],
  });
}

module.exports = { db, initDb, getSetting, setSetting };
