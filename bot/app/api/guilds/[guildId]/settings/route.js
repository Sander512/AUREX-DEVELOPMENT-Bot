const { getServerSession } = require("next-auth");
const { authOptions } = require("../../../../../lib/auth");
const { resolveAccess, canDo } = require("../../../../../lib/permissions");
const { prisma } = require("../../../../../lib/prisma");

async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const access = await resolveAccess(params.guildId, session.discordId);
  if (!canDo(access, "manageSettings")) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json();
  // Only allow a known, safe subset of fields to be updated from this route.
  const ALLOWED = ["accentColor", "welcomeEnabled", "welcomeChannelId", "welcomeMessage"];
  const data = {};
  for (const key of ALLOWED) {
    if (key in body) data[key] = body[key];
  }

  const settings = await prisma.guildSettings.update({
    where: { guildId: params.guildId },
    data,
  });

  return Response.json({ settings });
}

module.exports = { PATCH };
