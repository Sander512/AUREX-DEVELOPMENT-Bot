// api/routes/welcome.js
// Backing store for the configurable welcome-message system: one row per
// guild, edited from the dashboard. The bot reads this on every
// guildMemberAdd event to know what (if anything) to post/DM/assign.

const express = require('express');
const { db } = require('../database');
const { isDiscordId, isHexColor, normalizeHexColor } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKeyOrGuildAccess } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CONFIG = {
  enabled: 0,
  channel_id: null,
  content: 'Welkom {user}! 🎉',
  embed_enabled: 1,
  embed_title: 'Welkom op de server!',
  embed_description: '{user} is zojuist lid geworden. We zijn nu met **{membercount}** leden!',
  embed_color: '10b981',
  embed_image: null,
  embed_footer: '© Aurex | Development',
  use_avatar_thumbnail: 1,
  auto_role_id: null,
  dm_enabled: 0,
  dm_message: 'Welkom bij Aurex | Development, {username}! Fijn dat je er bent.',
};

const FIELD_MAP = {
  enabled: 'enabled',
  channelId: 'channel_id',
  content: 'content',
  embedEnabled: 'embed_enabled',
  embedTitle: 'embed_title',
  embedDescription: 'embed_description',
  embedColor: 'embed_color',
  embedImage: 'embed_image',
  embedFooter: 'embed_footer',
  useAvatarThumbnail: 'use_avatar_thumbnail',
  autoRoleId: 'auto_role_id',
  dmEnabled: 'dm_enabled',
  dmMessage: 'dm_message',
};

function rowToConfig(row) {
  const source = row || { guild_id: null, ...DEFAULT_CONFIG };
  return {
    guildId: source.guild_id,
    configured: !!row,
    enabled: !!Number(source.enabled),
    channelId: source.channel_id || null,
    content: source.content || '',
    embedEnabled: !!Number(source.embed_enabled),
    embedTitle: source.embed_title || '',
    embedDescription: source.embed_description || '',
    embedColor: source.embed_color || DEFAULT_CONFIG.embed_color,
    embedImage: source.embed_image || null,
    embedFooter: source.embed_footer || null,
    useAvatarThumbnail: !!Number(source.use_avatar_thumbnail),
    autoRoleId: source.auto_role_id || null,
    dmEnabled: !!Number(source.dm_enabled),
    dmMessage: source.dm_message || '',
  };
}

async function ensureConfigRow(guildId) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO welcome_config (guild_id, enabled, content, embed_enabled, embed_title, embed_description, embed_color, embed_footer, use_avatar_thumbnail, dm_enabled, dm_message, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(guild_id) DO NOTHING`,
    args: [
      guildId,
      DEFAULT_CONFIG.enabled,
      DEFAULT_CONFIG.content,
      DEFAULT_CONFIG.embed_enabled,
      DEFAULT_CONFIG.embed_title,
      DEFAULT_CONFIG.embed_description,
      DEFAULT_CONFIG.embed_color,
      DEFAULT_CONFIG.embed_footer,
      DEFAULT_CONFIG.use_avatar_thumbnail,
      DEFAULT_CONFIG.dm_enabled,
      DEFAULT_CONFIG.dm_message,
      now,
      now,
    ],
  });
}

async function getConfigRow(guildId) {
  const result = await db.execute({ sql: 'SELECT * FROM welcome_config WHERE guild_id = ?', args: [guildId] });
  return result.rows[0] || null;
}

// GET /welcome/config/:guildId
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

// POST /welcome/config  { guildId, ...fieldsToUpdate }
// Partial update — only fields present in the body are changed.
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

      if (column === 'embed_color') {
        if (value !== null && !isHexColor(value)) {
          return res.status(400).json({ error: 'embedColor must be a 6-digit hex color, e.g. 10b981' });
        }
        value = value === null ? DEFAULT_CONFIG.embed_color : normalizeHexColor(value);
      }

      if (['channel_id', 'auto_role_id'].includes(column)) {
        if (value !== null && !isDiscordId(String(value))) {
          return res.status(400).json({ error: `${camelKey} must be a valid Discord snowflake ID or null` });
        }
      }

      if (['enabled', 'embed_enabled', 'use_avatar_thumbnail', 'dm_enabled'].includes(column)) {
        value = value ? 1 : 0;
      }

      if (['content', 'embed_title', 'embed_description', 'embed_footer', 'embed_image', 'dm_message'].includes(column)) {
        if (value !== null && (typeof value !== 'string' || value.length > 2000)) {
          return res.status(400).json({ error: `${camelKey} must be a string under 2000 characters` });
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
      sql: `UPDATE welcome_config SET ${setClauses.join(', ')} WHERE guild_id = ?`,
      args,
    });

    const row = await getConfigRow(guildId);
    res.json({ config: rowToConfig(row) });
  })
);

module.exports = router;
