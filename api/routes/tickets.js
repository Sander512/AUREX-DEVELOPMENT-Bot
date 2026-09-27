// api/routes/tickets.js
// Backing store for the fully configurable ticket panel system.
//
//   ticket_config  — one row per guild: how the panel looks + behaves
//   ticket_types   — the buttons/options on the panel (each can override
//                     category/role/naming/welcome message)
//   tickets        — every ticket ever opened, for numbering + status

const express = require('express');
const { db } = require('../database');
const {
  isDiscordId,
  isHexColor,
  normalizeHexColor,
  isTicketKey,
  slugify,
  isPositiveInteger,
} = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKey, requireApiKeyOrGuildAccess } = require('../middleware/auth');

const router = express.Router();

const MAX_TYPES_PER_GUILD = 25; // Discord select menu hard limit

const DEFAULT_CONFIG = {
  panel_title: 'Support Tickets',
  panel_description: 'Klik hieronder op het onderwerp dat het beste past om een ticket te openen.',
  panel_color: '1e3a8a',
  panel_image: null,
  panel_thumbnail: null,
  panel_footer: '© Aurex | Development',
  category_id: null,
  log_channel_id: null,
  transcript_channel_id: null,
  support_role_id: null,
  name_format: 'ticket-{number}',
  welcome_message:
    'Bedankt voor je ticket, {user}! Beschrijf je vraag of probleem zo duidelijk mogelijk — het team helpt je zo snel mogelijk.',
  max_open_per_user: 1,
  require_close_reason: 0,
  ping_support_role: 1,
  show_ticket_info: 1,
  ticket_counter: 0,
};

// Maps the camelCase fields accepted over the API to their DB columns.
const CONFIG_FIELD_MAP = {
  panelTitle: 'panel_title',
  panelDescription: 'panel_description',
  panelColor: 'panel_color',
  panelImage: 'panel_image',
  panelThumbnail: 'panel_thumbnail',
  panelFooter: 'panel_footer',
  categoryId: 'category_id',
  logChannelId: 'log_channel_id',
  transcriptChannelId: 'transcript_channel_id',
  supportRoleId: 'support_role_id',
  nameFormat: 'name_format',
  welcomeMessage: 'welcome_message',
  maxOpenPerUser: 'max_open_per_user',
  requireCloseReason: 'require_close_reason',
  pingSupportRole: 'ping_support_role',
  showTicketInfo: 'show_ticket_info',
};

function rowToConfig(row) {
  const source = row || { guild_id: null, ...DEFAULT_CONFIG };
  return {
    guildId: source.guild_id,
    configured: !!row,
    panelTitle: source.panel_title,
    panelDescription: source.panel_description,
    panelColor: source.panel_color,
    panelImage: source.panel_image || null,
    panelThumbnail: source.panel_thumbnail || null,
    panelFooter: source.panel_footer || null,
    categoryId: source.category_id || null,
    logChannelId: source.log_channel_id || null,
    transcriptChannelId: source.transcript_channel_id || null,
    supportRoleId: source.support_role_id || null,
    nameFormat: source.name_format,
    welcomeMessage: source.welcome_message,
    maxOpenPerUser: Number(source.max_open_per_user),
    requireCloseReason: !!Number(source.require_close_reason),
    pingSupportRole: !!Number(source.ping_support_role),
    showTicketInfo: source.show_ticket_info === undefined ? true : !!Number(source.show_ticket_info),
    ticketCounter: Number(source.ticket_counter || 0),
  };
}

function rowToType(row) {
  return {
    key: row.key,
    label: row.label,
    emoji: row.emoji || null,
    description: row.description || null,
    categoryId: row.category_id || null,
    supportRoleId: row.support_role_id || null,
    nameFormat: row.name_format || null,
    welcomeMessage: row.welcome_message || null,
    position: row.position,
    claimEnabled: row.claim_enabled === undefined ? true : !!Number(row.claim_enabled),
    closeEnabled: row.close_enabled === undefined ? true : !!Number(row.close_enabled),
    askDescription: row.ask_description === undefined ? true : !!Number(row.ask_description),
    maxOpenOverride: row.max_open_override === null || row.max_open_override === undefined ? null : Number(row.max_open_override),
  };
}

async function ensureConfigRow(guildId) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO ticket_config (guild_id, panel_title, panel_description, panel_color, name_format, welcome_message, max_open_per_user, require_close_reason, ping_support_role, show_ticket_info, ticket_counter, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(guild_id) DO NOTHING`,
    args: [
      guildId,
      DEFAULT_CONFIG.panel_title,
      DEFAULT_CONFIG.panel_description,
      DEFAULT_CONFIG.panel_color,
      DEFAULT_CONFIG.name_format,
      DEFAULT_CONFIG.welcome_message,
      DEFAULT_CONFIG.max_open_per_user,
      DEFAULT_CONFIG.require_close_reason,
      DEFAULT_CONFIG.ping_support_role,
      DEFAULT_CONFIG.show_ticket_info,
      now,
      now,
    ],
  });
}

async function getConfigRow(guildId) {
  const result = await db.execute({ sql: 'SELECT * FROM ticket_config WHERE guild_id = ?', args: [guildId] });
  return result.rows[0] || null;
}

async function getTypeRows(guildId) {
  const result = await db.execute({
    sql: 'SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY position ASC, id ASC',
    args: [guildId],
  });
  return result.rows;
}

// GET /tickets/config/:guildId
// Returns the panel configuration plus its configured ticket types.
router.get(
  '/config/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const row = await getConfigRow(guildId);
    const types = await getTypeRows(guildId);

    res.json({ config: rowToConfig(row), types: types.map(rowToType) });
  })
);

// POST /tickets/config  { guildId, ...fieldsToUpdate }
// Partial update — only fields present in the body are changed. Creates
// the row with defaults first if this guild has never been configured.
router.post(
  '/config',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const setClauses = [];
    const args = [];

    for (const [camelKey, column] of Object.entries(CONFIG_FIELD_MAP)) {
      if (!(camelKey in fields)) continue;
      let value = fields[camelKey];

      if (column === 'panel_color') {
        if (value !== null && !isHexColor(value)) {
          return res.status(400).json({ error: 'panelColor must be a 6-digit hex color, e.g. 1e3a8a' });
        }
        value = value === null ? DEFAULT_CONFIG.panel_color : normalizeHexColor(value);
      }

      if (['category_id', 'log_channel_id', 'transcript_channel_id', 'support_role_id'].includes(column)) {
        if (value !== null && !isDiscordId(String(value))) {
          return res.status(400).json({ error: `${camelKey} must be a valid Discord snowflake ID or null` });
        }
      }

      if (column === 'max_open_per_user') {
        if (!isPositiveInteger(Number(value), 25) || Number(value) < 1) {
          return res.status(400).json({ error: 'maxOpenPerUser must be an integer between 1 and 25' });
        }
        value = Number(value);
      }

      if (['require_close_reason', 'ping_support_role', 'show_ticket_info'].includes(column)) {
        value = value ? 1 : 0;
      }

      if (['panel_title', 'panel_description', 'welcome_message', 'name_format', 'panel_footer', 'panel_image', 'panel_thumbnail'].includes(column)) {
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
      sql: `UPDATE ticket_config SET ${setClauses.join(', ')} WHERE guild_id = ?`,
      args,
    });

    const row = await getConfigRow(guildId);
    res.json({ config: rowToConfig(row) });
  })
);

// GET /tickets/types/:guildId
router.get(
  '/types/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const types = await getTypeRows(guildId);
    res.json({ types: types.map(rowToType) });
  })
);

// POST /tickets/types  { guildId, key?, label, emoji?, description?, categoryId?, supportRoleId?, nameFormat?, welcomeMessage? }
router.post(
  '/types',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, label } = req.body || {};
    let {
      key,
      emoji,
      description,
      categoryId,
      supportRoleId,
      nameFormat,
      welcomeMessage,
      claimEnabled,
      closeEnabled,
      askDescription,
      maxOpenOverride,
    } = req.body || {};

    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 80) {
      return res.status(400).json({ error: 'label is required and must be 1-80 characters' });
    }

    key = key ? String(key).toLowerCase() : slugify(label);
    if (!isTicketKey(key)) {
      return res.status(400).json({ error: 'key must be 1-32 characters: lowercase letters, numbers, - or _' });
    }

    if (emoji !== undefined && emoji !== null && (typeof emoji !== 'string' || emoji.length > 100)) {
      return res.status(400).json({ error: 'emoji must be a short string' });
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 100)) {
      return res.status(400).json({ error: 'description must be under 100 characters (Discord select menu limit)' });
    }
    for (const [name, val] of [['categoryId', categoryId], ['supportRoleId', supportRoleId]]) {
      if (val !== undefined && val !== null && !isDiscordId(String(val))) {
        return res.status(400).json({ error: `${name} must be a valid Discord snowflake ID` });
      }
    }
    if (nameFormat !== undefined && nameFormat !== null && (typeof nameFormat !== 'string' || nameFormat.length > 100)) {
      return res.status(400).json({ error: 'nameFormat must be under 100 characters' });
    }
    if (welcomeMessage !== undefined && welcomeMessage !== null && (typeof welcomeMessage !== 'string' || welcomeMessage.length > 2000)) {
      return res.status(400).json({ error: 'welcomeMessage must be under 2000 characters' });
    }
    if (maxOpenOverride !== undefined && maxOpenOverride !== null) {
      if (!isPositiveInteger(Number(maxOpenOverride), 25) || Number(maxOpenOverride) < 1) {
        return res.status(400).json({ error: 'maxOpenOverride must be an integer between 1 and 25, or null' });
      }
      maxOpenOverride = Number(maxOpenOverride);
    } else {
      maxOpenOverride = null;
    }

    const existing = await getTypeRows(guildId);
    if (existing.length >= MAX_TYPES_PER_GUILD) {
      return res.status(409).json({ error: `Maximaal ${MAX_TYPES_PER_GUILD} ticket types per server (Discord select menu limiet)` });
    }
    if (existing.some((t) => t.key === key)) {
      return res.status(409).json({ error: `Er bestaat al een ticket type met key '${key}'` });
    }

    await ensureConfigRow(guildId);

    await db.execute({
      sql: `INSERT INTO ticket_types (guild_id, key, label, emoji, description, category_id, support_role_id, name_format, welcome_message, position, claim_enabled, close_enabled, ask_description, max_open_override, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        guildId,
        key,
        label.trim(),
        emoji || null,
        description || null,
        categoryId || null,
        supportRoleId || null,
        nameFormat || null,
        welcomeMessage || null,
        existing.length,
        claimEnabled === false ? 0 : 1,
        closeEnabled === false ? 0 : 1,
        askDescription === false ? 0 : 1,
        maxOpenOverride,
        Date.now(),
      ],
    });

    res.status(201).json({ type: { key, label: label.trim(), emoji: emoji || null, description: description || null } });
  })
);

// PATCH /tickets/types/:guildId/:key  { label?, emoji?, description?, categoryId?, supportRoleId?, nameFormat?, welcomeMessage?, claimEnabled?, closeEnabled?, askDescription?, maxOpenOverride? }
// Partial update of an existing ticket type — only fields present in the body are changed.
router.patch(
  '/types/:guildId/:key',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, key } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const existingRows = await getTypeRows(guildId);
    const current = existingRows.find((t) => t.key === key);
    if (!current) return res.status(404).json({ error: `Geen ticket type gevonden met key '${key}'` });

    const fields = req.body || {};
    const setClauses = [];
    const args = [];

    if ('label' in fields) {
      if (typeof fields.label !== 'string' || fields.label.trim().length === 0 || fields.label.length > 80) {
        return res.status(400).json({ error: 'label must be 1-80 characters' });
      }
      setClauses.push('label = ?');
      args.push(fields.label.trim());
    }
    if ('emoji' in fields) {
      if (fields.emoji !== null && (typeof fields.emoji !== 'string' || fields.emoji.length > 100)) {
        return res.status(400).json({ error: 'emoji must be a short string or null' });
      }
      setClauses.push('emoji = ?');
      args.push(fields.emoji || null);
    }
    if ('description' in fields) {
      if (fields.description !== null && (typeof fields.description !== 'string' || fields.description.length > 100)) {
        return res.status(400).json({ error: 'description must be under 100 characters or null' });
      }
      setClauses.push('description = ?');
      args.push(fields.description || null);
    }
    for (const [key2, column] of [['categoryId', 'category_id'], ['supportRoleId', 'support_role_id']]) {
      if (key2 in fields) {
        const val = fields[key2];
        if (val !== null && !isDiscordId(String(val))) {
          return res.status(400).json({ error: `${key2} must be a valid Discord snowflake ID or null` });
        }
        setClauses.push(`${column} = ?`);
        args.push(val || null);
      }
    }
    if ('nameFormat' in fields) {
      if (fields.nameFormat !== null && (typeof fields.nameFormat !== 'string' || fields.nameFormat.length > 100)) {
        return res.status(400).json({ error: 'nameFormat must be under 100 characters or null' });
      }
      setClauses.push('name_format = ?');
      args.push(fields.nameFormat || null);
    }
    if ('welcomeMessage' in fields) {
      if (fields.welcomeMessage !== null && (typeof fields.welcomeMessage !== 'string' || fields.welcomeMessage.length > 2000)) {
        return res.status(400).json({ error: 'welcomeMessage must be under 2000 characters or null' });
      }
      setClauses.push('welcome_message = ?');
      args.push(fields.welcomeMessage || null);
    }
    if ('claimEnabled' in fields) {
      setClauses.push('claim_enabled = ?');
      args.push(fields.claimEnabled ? 1 : 0);
    }
    if ('closeEnabled' in fields) {
      setClauses.push('close_enabled = ?');
      args.push(fields.closeEnabled ? 1 : 0);
    }
    if ('askDescription' in fields) {
      setClauses.push('ask_description = ?');
      args.push(fields.askDescription ? 1 : 0);
    }
    if ('maxOpenOverride' in fields) {
      const val = fields.maxOpenOverride;
      if (val !== null && (!isPositiveInteger(Number(val), 25) || Number(val) < 1)) {
        return res.status(400).json({ error: 'maxOpenOverride must be an integer between 1 and 25, or null' });
      }
      setClauses.push('max_open_override = ?');
      args.push(val === null ? null : Number(val));
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update were provided' });
    }

    args.push(guildId, key);
    await db.execute({
      sql: `UPDATE ticket_types SET ${setClauses.join(', ')} WHERE guild_id = ? AND key = ?`,
      args,
    });

    const updated = (await getTypeRows(guildId)).find((t) => t.key === key);
    res.json({ type: rowToType(updated) });
  })
);

// DELETE /tickets/types/:guildId/:key
router.delete(
  '/types/:guildId/:key',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, key } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: 'DELETE FROM ticket_types WHERE guild_id = ? AND key = ?',
      args: [guildId, key],
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: `Geen ticket type gevonden met key '${key}'` });
    }

    res.json({ success: true });
  })
);

// GET /tickets/open-count/:guildId/:openerId?typeKey=xyz
// Without typeKey: total open tickets by this user in the guild (used
// against the guild-wide maxOpenPerUser). With typeKey: open tickets of
// just that type (used when a type overrides the limit for itself).
router.get(
  '/open-count/:guildId/:openerId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId, openerId } = req.params;
    const { typeKey } = req.query;
    if (!isDiscordId(guildId) || !isDiscordId(openerId)) {
      return res.status(400).json({ error: 'Invalid guildId or openerId' });
    }

    const sql = typeKey
      ? `SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND opener_id = ? AND type_key = ? AND status != 'closed'`
      : `SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND opener_id = ? AND status != 'closed'`;
    const args = typeKey ? [guildId, openerId, typeKey] : [guildId, openerId];

    const result = await db.execute({ sql, args });

    res.json({ count: Number(result.rows[0].count) });
  })
);

// POST /tickets/create  { guildId, channelId, openerId, typeKey?, typeLabel? }
// Atomically bumps the per-guild ticket counter and records the ticket.
router.post(
  '/create',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId, channelId, openerId, typeKey, typeLabel } = req.body || {};

    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    if (!isDiscordId(channelId)) return res.status(400).json({ error: 'Invalid or missing channelId' });
    if (!isDiscordId(openerId)) return res.status(400).json({ error: 'Invalid or missing openerId' });

    await ensureConfigRow(guildId);

    const counterResult = await db.execute({
      sql: `UPDATE ticket_config SET ticket_counter = ticket_counter + 1, updated_at = ? WHERE guild_id = ? RETURNING ticket_counter`,
      args: [Date.now(), guildId],
    });
    const ticketNumber = Number(counterResult.rows[0].ticket_counter);

    try {
      await db.execute({
        sql: `INSERT INTO tickets (guild_id, channel_id, opener_id, type_key, type_label, ticket_number, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        args: [guildId, channelId, openerId, typeKey || null, typeLabel || null, ticketNumber, Date.now()],
      });
    } catch (err) {
      return res.status(409).json({ error: 'Er bestaat al een ticket voor dit kanaal' });
    }

    res.status(201).json({ ticketNumber, channelId });
  })
);

// GET /tickets/by-channel/:channelId
router.get(
  '/by-channel/:channelId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { channelId } = req.params;
    if (!isDiscordId(channelId)) return res.status(400).json({ error: 'Invalid channelId' });

    const result = await db.execute({ sql: 'SELECT * FROM tickets WHERE channel_id = ?', args: [channelId] });
    const ticket = result.rows[0];
    if (!ticket) return res.status(404).json({ error: 'Geen ticket gevonden voor dit kanaal' });

    res.json({
      id: ticket.id,
      guildId: ticket.guild_id,
      channelId: ticket.channel_id,
      openerId: ticket.opener_id,
      typeKey: ticket.type_key,
      typeLabel: ticket.type_label,
      ticketNumber: ticket.ticket_number,
      status: ticket.status,
      claimedBy: ticket.claimed_by,
      closeReason: ticket.close_reason,
      closedBy: ticket.closed_by,
      createdAt: ticket.created_at,
      closedAt: ticket.closed_at,
    });
  })
);

// GET /tickets/list/:guildId?status=open
router.get(
  '/list/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const status = req.query.status;
    const sql = status
      ? 'SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50'
      : 'SELECT * FROM tickets WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50';
    const args = status ? [guildId, status] : [guildId];

    const result = await db.execute({ sql, args });

    res.json({
      tickets: result.rows.map((t) => ({
        channelId: t.channel_id,
        openerId: t.opener_id,
        typeLabel: t.type_label,
        ticketNumber: t.ticket_number,
        status: t.status,
        claimedBy: t.claimed_by,
        createdAt: t.created_at,
      })),
    });
  })
);

// POST /tickets/claim  { channelId, claimedBy }
router.post(
  '/claim',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { channelId, claimedBy } = req.body || {};
    if (!isDiscordId(channelId)) return res.status(400).json({ error: 'Invalid channelId' });
    if (!isDiscordId(claimedBy)) return res.status(400).json({ error: 'Invalid claimedBy' });

    const existingResult = await db.execute({ sql: 'SELECT * FROM tickets WHERE channel_id = ?', args: [channelId] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Geen ticket gevonden voor dit kanaal' });
    if (existing.status === 'closed') return res.status(409).json({ error: 'Dit ticket is al gesloten' });

    await db.execute({
      sql: `UPDATE tickets SET status = 'claimed', claimed_by = ? WHERE channel_id = ?`,
      args: [claimedBy, channelId],
    });

    res.json({ success: true });
  })
);

// POST /tickets/close  { channelId, closedBy, reason? }
router.post(
  '/close',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { channelId, closedBy, reason } = req.body || {};
    if (!isDiscordId(channelId)) return res.status(400).json({ error: 'Invalid channelId' });
    if (!isDiscordId(closedBy)) return res.status(400).json({ error: 'Invalid closedBy' });

    const existingResult = await db.execute({ sql: 'SELECT * FROM tickets WHERE channel_id = ?', args: [channelId] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Geen ticket gevonden voor dit kanaal' });
    if (existing.status === 'closed') return res.status(409).json({ error: 'Dit ticket is al gesloten' });

    await db.execute({
      sql: `UPDATE tickets SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ? WHERE channel_id = ?`,
      args: [closedBy, reason || null, Date.now(), channelId],
    });

    res.json({ success: true, ticketNumber: existing.ticket_number, openerId: existing.opener_id });
  })
);

module.exports = router;
