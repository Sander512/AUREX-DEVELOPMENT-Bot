const { getSessionUser } = require("../../../lib/session");
const { resolveAccess, canDo } = require("../../../lib/permissions");
const { prisma } = require("../../../lib/prisma");

const VALID_STATUSES = [
  "PENDING", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS",
  "AWAITING_CUSTOMER", "COMPLETED", "CANCELLED", "REFUNDED",
];

async function PATCH(request) {
  const session = getSessionUser(request.cookies);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { guildId, orderId, status } = await request.json();
  if (!guildId || !orderId) return Response.json({ error: "guildId/orderId ontbreekt" }, { status: 400 });

  const access = await resolveAccess(guildId, session.discordId);
  if (!canDo(access, "manageOrders")) return Response.json({ error: "forbidden" }, { status: 403 });

  if (!VALID_STATUSES.includes(status)) {
    return Response.json({ error: "Ongeldige status." }, { status: 400 });
  }

  const existing = await prisma.order.findFirst({ where: { id: orderId, guildId } });
  if (!existing) return Response.json({ error: "Order niet gevonden voor deze server." }, { status: 404 });

  const order = await prisma.order.update({
    where: { id: orderId },
    data: { status },
  });

  return Response.json({ order });
}

module.exports = { PATCH };
