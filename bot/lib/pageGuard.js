const { cookies } = require("next/headers");
const { redirect } = require("next/navigation");
const { getSessionUser } = require("./session");
const { resolveAccess } = require("./permissions");

/**
 * Every dashboard page calls this first. Using ?guild= as a query param
 * (instead of a [guildId] dynamic route segment) means Next.js never needs
 * a bracket-named folder anywhere in the dashboard routes.
 */
async function requirePageAccess(guildId) {
  const session = getSessionUser(cookies());
  if (!session) {
    redirect(`/api/auth/discord?callbackUrl=${encodeURIComponent(`/dashboard?guild=${guildId || ""}`)}`);
  }

  if (!guildId) {
    return { session, access: null, noGuild: true };
  }

  const access = await resolveAccess(guildId, session.discordId);
  return { session, access };
}

module.exports = { requirePageAccess };
