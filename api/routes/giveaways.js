// api/routes/giveaways.js
// Backing store for the classic reaction-based giveaway system (🎉, same
// spirit as GiveawayBot). Entries themselves are never stored here — the
// bot reads the live list of 🎉 reactors straight from Discord when a
// giveaway ends or is rerolled. This table only tracks what the giveaway
// IS (prize, winner count, host, requirement, deadline) and how it ended.

const express = require('express');
const { db } = require('../database');
const { isDiscordId, isPositiveInteger } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKey, requireApiKeyOrGuildAccess } = require('../middleware/auth');

const router = express.Router();

function rowToGiveaway(row) {
  const entries = row.entries ? JSON.parse(row.entries) : [];
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    prize: row.prize,
    description: row.description || null,
    winnerCount: Number(row.winner_count),
    hostId: row.host_id,
    requiredRoleId: row.required_role_id || null,
    status: row.status,
    entries,
    entryCount: entries.length,
    winners: row.winners ? JSON.parse(row.winners) : null,
    endsAt: Number(row.ends_at),
    createdAt: Number(row.created_at),
    endedAt: row.ended_at ? Number(row.ended_at) : null,
  };
}

// POST /giveaways/create
// { guildId, channelId, messageId, prize, description?, winnerCount, hostId, requiredRoleId?, endsAt }
router.post(
  '/create',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId, channelId, messageId, prize, description, winnerCount, hostId, requiredRoleId, endsAt } = req.body || {};

    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    if (!isDiscordId(channelId)) return res.status(400).json({ error: 'Invalid or missing channelId' });
    if (!isDiscordId(messageId)) return res.status(400).json({ error: 'Invalid or missing messageId' });
    if (!isDiscordId(hostId)) return res.status(400).json({ error: 'Invalid or missing hostId' });
    if (typeof prize !== 'string' || !prize.trim() || prize.length > 256) {
      return res.status(400).json({ error: 'prize must be a non-empty string under 256 characters' });
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 1000)) {
      return res.status(400).json({ error: 'description must be a string under 1000 characters' });
    }
    if (!isPositiveInteger(Number(winnerCount), 50) || Number(winnerCount) < 1) {
      return res.status(400).json({ error: 'winnerCount must be an integer between 1 and 50' });
    }
    if (requiredRoleId !== undefined && requiredRoleId !== null && !isDiscordId(String(requiredRoleId))) {
      return res.status(400).json({ error: 'requiredRoleId must be a valid Discord snowflake ID or null' });
    }
    if (!Number.isInteger(endsAt) || endsAt <= Date.now()) {
      return res.status(400).json({ error: 'endsAt must be a future timestamp (ms)' });
    }

    const now = Date.now();
    let result;
    try {
      result = await db.execute({
        sql: `INSERT INTO giveaways (guild_id, channel_id, message_id, prize, description, winner_count, host_id, required_role_id, status, entries, ends_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?)`,
        args: [guildId, channelId, messageId, prize.trim(), description?.trim() || null, Number(winnerCount), hostId, requiredRoleId || null, endsAt, now],
      });
    } catch (err) {
      return res.status(409).json({ error: 'Er bestaat al een giveaway voor dit bericht' });
    }

    res.status(201).json({ id: Number(result.lastInsertRowid) });
  })
);

// POST /giveaways/enter  { id, userId }
// Toggles a user's entry (click to join, click again to leave) — this is
// what the 🎉 "Enter" button on the giveaway message calls. Returns the
// new state so the bot can update the "Entries: N" counter immediately.
router.post(
  '/enter',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id, userId } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    if (!isDiscordId(userId)) return res.status(400).json({ error: 'Invalid or missing userId' });

    const existingResult = await db.execute({ sql: 'SELECT * FROM giveaways WHERE id = ?', args: [id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Giveaway niet gevonden' });
    if (existing.status !== 'active') return res.status(409).json({ error: 'Deze giveaway is niet meer actief' });

    const entries = existing.entries ? JSON.parse(existing.entries) : [];
    const idx = entries.indexOf(userId);
    let entered;
    if (idx === -1) {
      entries.push(userId);
      entered = true;
    } else {
      entries.splice(idx, 1);
      entered = false;
    }

    await db.execute({
      sql: `UPDATE giveaways SET entries = ? WHERE id = ?`,
      args: [JSON.stringify(entries), id],
    });

    res.json({ entered, count: entries.length });
  })
);

// GET /giveaways/active
// All giveaways with status='active', across every guild — used by the
// bot's own scheduler to know what needs to be drawn/updated. Bot-only.
router.get(
  '/active',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const result = await db.execute({ sql: `SELECT * FROM giveaways WHERE status = 'active' ORDER BY ends_at ASC`, args: [] });
    res.json({ giveaways: result.rows.map(rowToGiveaway) });
  })
);

// GET /giveaways/guild/:guildId?status=active|ended|cancelled
// Powers the dashboard overview. Accepts either the bot key or a
// dashboard session scoped to that guild.
router.get(
  '/guild/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const status = req.query.status;
    const sql = status
      ? 'SELECT * FROM giveaways WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50'
      : 'SELECT * FROM giveaways WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50';
    const args = status ? [guildId, status] : [guildId];

    const result = await db.execute({ sql, args });
    res.json({ giveaways: result.rows.map(rowToGiveaway) });
  })
);

// GET /giveaways/:id
router.get(
  '/:id',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const result = await db.execute({ sql: 'SELECT * FROM giveaways WHERE id = ?', args: [id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Giveaway niet gevonden' });

    res.json({ giveaway: rowToGiveaway(row) });
  })
);

// POST /giveaways/end  { id, winners: string[] }
// Marks a giveaway as ended and records who won. Also used for the initial
// draw when a giveaway's timer runs out.
router.post(
  '/end',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id, winners } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    if (!Array.isArray(winners) || !winners.every((w) => isDiscordId(w))) {
      return res.status(400).json({ error: 'winners must be an array of Discord snowflake IDs (may be empty)' });
    }

    const existingResult = await db.execute({ sql: 'SELECT * FROM giveaways WHERE id = ?', args: [id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Giveaway niet gevonden' });

    await db.execute({
      sql: `UPDATE giveaways SET status = 'ended', winners = ?, ended_at = ? WHERE id = ?`,
      args: [JSON.stringify(winners), Date.now(), id],
    });

    res.json({ success: true });
  })
);

// POST /giveaways/reroll  { id, winners: string[] }
// A reroll doesn't change status (already 'ended') — just overwrites who
// the recorded winners are, so /giveaway-list and the dashboard stay accurate.
router.post(
  '/reroll',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id, winners } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    if (!Array.isArray(winners) || winners.length === 0 || !winners.every((w) => isDiscordId(w))) {
      return res.status(400).json({ error: 'winners must be a non-empty array of Discord snowflake IDs' });
    }

    const existingResult = await db.execute({ sql: 'SELECT * FROM giveaways WHERE id = ?', args: [id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Giveaway niet gevonden' });
    if (existing.status !== 'ended') return res.status(409).json({ error: 'Alleen een afgelopen giveaway kan opnieuw getrokken worden' });

    await db.execute({
      sql: `UPDATE giveaways SET winners = ? WHERE id = ?`,
      args: [JSON.stringify(winners), id],
    });

    res.json({ success: true });
  })
);

// POST /giveaways/cancel  { id }
// Used when the underlying message/channel got deleted so the scheduler
// stops retrying it forever.
router.post(
  '/cancel',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    await db.execute({ sql: `UPDATE giveaways SET status = 'cancelled', ended_at = ? WHERE id = ?`, args: [Date.now(), id] });
    res.json({ success: true });
  })
);

module.exports = router;
