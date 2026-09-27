const { getSessionUser } = require("../../../lib/session");
const { resolveAccess, canDo } = require("../../../lib/permissions");
const { prisma } = require("../../../lib/prisma");

const ALLOWED = ["accentColor", "welcomeEnabled", "welcomeChannelId", "welcomeMessage"];

async function PATCH(request) {
  const session = getSessionUser(request.cookies);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const { guildId } = body;
  if (!guildId) return Response.json({ error: "guildId ontbreekt" }, { status: 400 });

  const access = await resolveAccess(guildId, session.discordId);
  if (!canDo(access, "manageSettings")) return Response.json({ error: "forbidden" }, { status: 403 });

  const data = {};
  for (const key of ALLOWED) {
    if (key in body) data[key] = body[key];
  }

  const settings = await prisma.guildSettings.update({ where: { guildId }, data });
  return Response.json({ settings });
}

module.exports = { PATCH };
