// api/routes/rules.js
// Backing store for the configurable rules embed: one row per guild,
// edited from the dashboard or posted/updated via /rules-send in Discord.

const express = require('express');
const { db } = require('../database');
const { isDiscordId, isHexColor, normalizeHexColor } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKeyOrGuildAccess } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CONFIG = {
  channel_id: null,
  title: '📜 Server Regels',
  description:
    '1️⃣ Wees respectvol naar iedereen.\n2️⃣ Geen spam, reclame of NSFW-content.\n3️⃣ Volg de Discord Richtlijnen.\n4️⃣ Luister naar het team.',
  color: '5865f2',
  image: null,
  footer: '© Aurex | Development',
  message_id: null,
};

const FIELD_MAP = {
  channelId: 'channel_id',
  title: 'title',
  description: 'description',
  color: 'color',
  image: 'image',
  footer: 'footer',
};

function rowToConfig(row) {
  const source = row || { guild_id: null, ...DEFAULT_CONFIG };
  return {
    guildId: source.guild_id,
    configured: !!row,
    channelId: source.channel_id || null,
    title: source.title || DEFAULT_CONFIG.title,
    description: source.description || DEFAULT_CONFIG.description,
    color: source.color || DEFAULT_CONFIG.color,
    image: source.image || null,
    footer: source.footer || null,
    messageId: source.message_id || null,
  };
}

async function ensureConfigRow(guildId) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO rules_config (guild_id, title, description, color, footer, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(guild_id) DO NOTHING`,
    args: [guildId, DEFAULT_CONFIG.title, DEFAULT_CONFIG.description, DEFAULT_CONFIG.color, DEFAULT_CONFIG.footer, now, now],
  });
}

async function getConfigRow(guildId) {
  const result = await db.execute({ sql: 'SELECT * FROM rules_config WHERE guild_id = ?', args: [guildId] });
  return result.rows[0] || null;
}

// GET /rules/config/:guildId
router.get(
  '/config/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const row = await getConfigRow(guildId);
    res.json({ config: rowToConfig(row) });
  })
);

// POST /rules/config  { guildId, ...fieldsToUpdate }
router.post(
  '/config',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const setClauses = [];
    const args = [];

    for (const [camelKey, column] of Object.entries(FIELD_MAP)) {
      if (!(camelKey in fields)) continue;
      let value = fields[camelKey];

      if (column === 'color') {
        if (value !== null && !isHexColor(value)) {
          return res.status(400).json({ error: 'color must be a 6-digit hex color, e.g. 5865f2' });
        }
        value = value === null ? DEFAULT_CONFIG.color : normalizeHexColor(value);
      }

      if (column === 'channel_id') {
        if (value !== null && !isDiscordId(String(value))) {
          return res.status(400).json({ error: 'channelId must be a valid Discord snowflake ID or null' });
        }
      }

      if (['title', 'description', 'footer', 'image'].includes(column)) {
        if (value !== null && (typeof value !== 'string' || value.length > 4000)) {
          return res.status(400).json({ error: `${camelKey} must be a string under 4000 characters` });
        }
      }

      setClauses.push(`${column} = ?`);
      args.push(value);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update were provided' });
    }

    await ensureConfigRow(guildId);

    setClauses.push('updated_at = ?');
    args.push(Date.now());
    args.push(guildId);

    await db.execute({
      sql: `UPDATE rules_config SET ${setClauses.join(', ')} WHERE guild_id = ?`,
      args,
    });

    const row = await getConfigRow(guildId);
    res.json({ config: rowToConfig(row) });
  })
);

// POST /rules/message  { guildId, messageId }
// Called by the bot right after /rules-send posts (or re-posts) the embed,
// so the next /rules-send can EDIT that same message instead of spamming
// a new one every time.
router.post(
  '/message',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, messageId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    await ensureConfigRow(guildId);
    await db.execute({
      sql: `UPDATE rules_config SET message_id = ?, updated_at = ? WHERE guild_id = ?`,
      args: [messageId || null, Date.now(), guildId],
    });

    res.json({ success: true });
  })
);

module.exports = router;
