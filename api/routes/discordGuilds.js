// api/routes/discordGuilds.js
// The bot reports which Discord servers it's currently in here, so the
// dashboard's "kies een server" screen can be built without the API
// process ever needing direct access to the Discord gateway/client.
//
// Protected by requireApiKey — only the bot calls these.

const express = require('express');
const { db } = require('../database');
const { isDiscordId } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

function isValidGuildEntry(g) {
  return g && isDiscordId(String(g.id)) && typeof g.name === 'string' && g.name.length > 0 && g.name.length <= 100;
}

// POST /discord-guilds/sync  { guilds: [{ id, name, icon }] }
// Full replace — called once on bot ready. Guilds the bot left while
// offline (or was never in) are removed; everything currently reported
// is upserted.
router.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { guilds } = req.body || {};
    if (!Array.isArray(guilds) || !guilds.every(isValidGuildEntry)) {
      return res.status(400).json({ error: 'guilds must be an array of { id, name, icon? }' });
    }

    const now = Date.now();
    const keepIds = guilds.map((g) => String(g.id));

    await db.execute({ sql: 'DELETE FROM discord_guilds', args: [] });
    for (const g of guilds) {
      await db.execute({
        sql: `INSERT INTO discord_guilds (guild_id, name, icon, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(guild_id) DO UPDATE SET name = excluded.name, icon = excluded.icon, updated_at = excluded.updated_at`,
        args: [String(g.id), g.name, g.icon || null, now],
      });
    }

    res.json({ success: true, count: keepIds.length });
  })
);

// POST /discord-guilds/upsert  { id, name, icon? }
// Called on guildCreate (the bot just joined a new server).
router.post(
  '/upsert',
  asyncHandler(async (req, res) => {
    const { id, name, icon } = req.body || {};
    if (!isValidGuildEntry({ id, name })) {
      return res.status(400).json({ error: 'id and name are required; id must be a valid Discord snowflake' });
    }

    await db.execute({
      sql: `INSERT INTO discord_guilds (guild_id, name, icon, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET name = excluded.name, icon = excluded.icon, updated_at = excluded.updated_at`,
      args: [String(id), name, icon || null, Date.now()],
    });

    res.json({ success: true });
  })
);

// DELETE /discord-guilds/:guildId
// Called on guildDelete (the bot was removed from a server).
router.delete(
  '/:guildId',
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    await db.execute({ sql: 'DELETE FROM discord_guilds WHERE guild_id = ?', args: [guildId] });
    res.json({ success: true });
  })
);

module.exports = router;
