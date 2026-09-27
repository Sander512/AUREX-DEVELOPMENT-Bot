const { getServerSession } = require("next-auth");
const { authOptions } = require("../../../../lib/auth");
const { resolveAccess, canDo } = require("../../../../lib/permissions");
const { prisma } = require("../../../../lib/prisma");
const OrderStatusSelect = require("../../../../components/OrderStatusSelect").default;

module.exports = async function OrdersPage({ params }) {
  const session = await getServerSession(authOptions);
  const access = await resolveAccess(params.guildId, session.discordId);

  if (!canDo(access, "manageOrders")) {
    return <p style={{ color: "#999" }}>Je hebt geen rechten om orders te beheren.</p>;
  }

  const orders = await prisma.order.findMany({
    where: { guildId: params.guildId },
    include: { product: true, customer: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Orders</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#999", fontSize: "0.8rem" }}>
            <th style={{ padding: "0.5rem" }}>#</th>
            <th style={{ padding: "0.5rem" }}>Product</th>
            <th style={{ padding: "0.5rem" }}>Klant</th>
            <th style={{ padding: "0.5rem" }}>Bedrag</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} style={{ borderTop: "1px solid #222" }}>
              <td style={{ padding: "0.5rem" }}>{o.orderNumber}</td>
              <td style={{ padding: "0.5rem" }}>{o.product.name}</td>
              <td style={{ padding: "0.5rem", color: "#999" }}>{o.customer.discordUserId}</td>
              <td style={{ padding: "0.5rem" }}>€{(o.amountCents / 100).toFixed(2)}</td>
              <td style={{ padding: "0.5rem" }}>
                <OrderStatusSelect guildId={params.guildId} orderId={o.id} status={o.status} />
              </td>
            </tr>
          ))}
          {orders.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: "1rem", color: "#666" }}>
                Nog geen orders.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
