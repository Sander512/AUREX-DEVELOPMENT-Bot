const DISCORD_API = "https://discord.com/api/v10";

/**
 * Looks up a member's roles in a guild using the BOT token (not the user's
 * OAuth token). This only works for guilds the bot is actually in, which is
 * exactly the set of guilds this dashboard should ever show — so it doubles
 * as a "does this bot manage this server" check.
 */
async function getGuildMember(guildId, userId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    // Never cache permission-relevant data.
    cache: "no-store",
  });

  if (res.status === 404) return null; // user is not a member of this guild
  if (!res.ok) {
    throw new Error(`Discord API error (${res.status}) while fetching guild member`);
  }
  return res.json(); // { roles: [roleId, ...], user: {...}, ... }
}

async function getGuild(guildId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json(); // includes owner_id
}

module.exports = { getGuildMember, getGuild };
