const { getServerSession } = require("next-auth");
const { authOptions } = require("../../../../../lib/auth");
const { resolveAccess, canDo } = require("../../../../../lib/permissions");
const { prisma } = require("../../../../../lib/prisma");

async function requireCapability(guildId, capability) {
  const session = await getServerSession(authOptions);
  if (!session) return { error: "unauthorized", status: 401 };

  const access = await resolveAccess(guildId, session.discordId);
  if (!canDo(access, capability)) return { error: "forbidden", status: 403 };

  return { session, access };
}

async function GET(request, { params }) {
  const auth = await requireCapability(params.guildId, "manageProducts");
  if (auth.error) return Response.json({ error: auth.error }, { status: auth.status });

  const products = await prisma.product.findMany({
    where: { guildId: params.guildId },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ products });
}

async function POST(request, { params }) {
  const auth = await requireCapability(params.guildId, "manageProducts");
  if (auth.error) return Response.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const { name, slug, description, category, priceCents } = body;

  if (!name || !slug || !category || !Number.isInteger(priceCents)) {
    return Response.json({ error: "Ontbrekende of ongeldige velden." }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      guildId: params.guildId,
      name,
      slug,
      description: description || "",
      category,
      priceCents,
      features: body.features || [],
    },
  });

  return Response.json({ product }, { status: 201 });
}

module.exports = { GET, POST };
