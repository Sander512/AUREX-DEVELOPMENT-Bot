const { getServerSession } = require("next-auth");
const { authOptions } = require("../../../../../../lib/auth");
const { resolveAccess, canDo } = require("../../../../../../lib/permissions");
const { prisma } = require("../../../../../../lib/prisma");

const VALID_STATUSES = [
  "PENDING", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS",
  "AWAITING_CUSTOMER", "COMPLETED", "CANCELLED", "REFUNDED",
];

async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const access = await resolveAccess(params.guildId, session.discordId);
  if (!canDo(access, "manageOrders")) return Response.json({ error: "forbidden" }, { status: 403 });

  const { status } = await request.json();
  if (!VALID_STATUSES.includes(status)) {
    return Response.json({ error: "Ongeldige status." }, { status: 400 });
  }

  const order = await prisma.order.update({
    where: { id: params.orderId },
    data: { status },
  });

  // TODO: when order status flips to PAID/COMPLETED/REFUNDED, notify the
  // customer via DM (through the bot's internal API) if that setting is on,
  // and mirror the change to the logOrders channel.

  return Response.json({ order });
}

module.exports = { PATCH };
