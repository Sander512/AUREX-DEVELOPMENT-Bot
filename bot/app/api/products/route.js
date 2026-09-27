const { getSessionUser } = require("../../../lib/session");
const { resolveAccess, canDo } = require("../../../lib/permissions");
const { prisma } = require("../../../lib/prisma");
const { parseJson, toJsonString } = require("../../../lib/json");

async function requireCapability(cookieStore, guildId, capability) {
  const session = getSessionUser(cookieStore);
  if (!session) return { error: "unauthorized", status: 401 };

  const access = await resolveAccess(guildId, session.discordId);
  if (!canDo(access, capability)) return { error: "forbidden", status: 403 };

  return { session, access };
}

async function GET(request) {
  const guildId = new URL(request.url).searchParams.get("guildId");
  if (!guildId) return Response.json({ error: "guildId ontbreekt" }, { status: 400 });

  const auth = await requireCapability(request.cookies, guildId, "manageProducts");
  if (auth.error) return Response.json({ error: auth.error }, { status: auth.status });

  const products = await prisma.product.findMany({ where: { guildId }, orderBy: { createdAt: "desc" } });
  const withParsedFeatures = products.map((p) => ({ ...p, features: parseJson(p.features, []) }));
  return Response.json({ products: withParsedFeatures });
}

async function POST(request) {
  const body = await request.json();
  const { guildId, name, slug, description, category, priceCents } = body;

  if (!guildId) return Response.json({ error: "guildId ontbreekt" }, { status: 400 });

  const auth = await requireCapability(request.cookies, guildId, "manageProducts");
  if (auth.error) return Response.json({ error: auth.error }, { status: auth.status });

  if (!name || !slug || !category || !Number.isInteger(priceCents)) {
    return Response.json({ error: "Ontbrekende of ongeldige velden." }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      guildId,
      name,
      slug,
      description: description || "",
      category,
      priceCents,
      features: toJsonString(body.features || []),
    },
  });

  return Response.json({ product }, { status: 201 });
}

module.exports = { GET, POST };
