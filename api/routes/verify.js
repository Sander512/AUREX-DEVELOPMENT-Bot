// api/routes/verify.js
// Backing store for the configurable verify-panel system: one row per
// guild, edited from the dashboard or via /verify-panel in Discord.
// There is no external account-linking here — clicking the button simply
// grants the configured role.

const express = require('express');
const { db } = require('../database');
const { isDiscordId, isHexColor, normalizeHexColor } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKeyOrGuildAccess } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CONFIG = {
  role_ids: null,
  panel_title: '🔐 Verifieer jezelf',
  panel_description: 'Klik op de knop hieronder om jezelf te verifiëren en toegang te krijgen tot de server.',
  panel_color: '5865f2',
  panel_image: null,
  panel_footer: null,
  button_label: 'Verifiëren',
  log_channel_id: null,
};

const FIELD_MAP = {
  roleIds: 'role_ids',
  panelTitle: 'panel_title',
  panelDescription: 'panel_description',
  panelColor: 'panel_color',
  panelImage: 'panel_image',
  panelFooter: 'panel_footer',
  buttonLabel: 'button_label',
  logChannelId: 'log_channel_id',
};

function parseRoleIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

function rowToConfig(row) {
  const source = row || { guild_id: null, ...DEFAULT_CONFIG };
  return {
    guildId: source.guild_id,
    configured: !!row,
    roleIds: parseRoleIds(source.role_ids),
    panelTitle: source.panel_title || DEFAULT_CONFIG.panel_title,
    panelDescription: source.panel_description || DEFAULT_CONFIG.panel_description,
    panelColor: source.panel_color || DEFAULT_CONFIG.panel_color,
    panelImage: source.panel_image || null,
    panelFooter: source.panel_footer || null,
    buttonLabel: source.button_label || DEFAULT_CONFIG.button_label,
    logChannelId: source.log_channel_id || null,
  };
}

async function ensureConfigRow(guildId) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO verify_config (guild_id, panel_title, panel_description, panel_color, button_label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(guild_id) DO NOTHING`,
    args: [
      guildId,
      DEFAULT_CONFIG.panel_title,
      DEFAULT_CONFIG.panel_description,
      DEFAULT_CONFIG.panel_color,
      DEFAULT_CONFIG.button_label,
      now,
      now,
    ],
  });
}

async function getConfigRow(guildId) {
  const result = await db.execute({ sql: 'SELECT * FROM verify_config WHERE guild_id = ?', args: [guildId] });
  return result.rows[0] || null;
}

// GET /verify/config/:guildId
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

// POST /verify/config  { guildId, ...fieldsToUpdate }
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

      if (column === 'panel_color') {
        if (value !== null && !isHexColor(value)) {
          return res.status(400).json({ error: 'panelColor must be a 6-digit hex color, e.g. 5865f2' });
        }
        value = value === null ? DEFAULT_CONFIG.panel_color : normalizeHexColor(value);
      }

      if (column === 'log_channel_id') {
        if (value !== null && !isDiscordId(String(value))) {
          return res.status(400).json({ error: `${camelKey} must be a valid Discord snowflake ID or null` });
        }
      }

      if (column === 'role_ids') {
        if (value !== null) {
          if (!Array.isArray(value) || !value.every((id) => isDiscordId(String(id)))) {
            return res.status(400).json({ error: 'roleIds must be an array of valid Discord snowflake IDs, or null' });
          }
          // De-dupe while keeping order, then store as JSON — sqlite/libSQL
          // has no native array column type.
          value = JSON.stringify([...new Set(value.map(String))]);
        }
      }

      if (['panel_title', 'panel_description', 'panel_footer', 'panel_image', 'button_label'].includes(column)) {
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
      sql: `UPDATE verify_config SET ${setClauses.join(', ')} WHERE guild_id = ?`,
      args,
    });

    const row = await getConfigRow(guildId);
    res.json({ config: rowToConfig(row) });
  })
);

module.exports = router;
