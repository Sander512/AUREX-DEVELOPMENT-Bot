const { prisma } = require("../../lib/prisma");
const { requirePageAccess } = require("../../lib/pageGuard");
const DashboardShell = require("../../components/DashboardShell").default;
const { NoAccess } = require("../../components/DashboardShell");

module.exports = async function OverviewPage({ searchParams }) {
  const guildId = searchParams.guild;
  const { access } = await requirePageAccess(guildId);

  if (!guildId) {
    return <main style={{ padding: "3rem", textAlign: "center", color: "#999" }}>Geen server geselecteerd. Gebruik <code>/dashboard</code> in Discord.</main>;
  }
  if (!access) return <NoAccess />;

  const [openTickets, pendingOrders, products, customers] = await Promise.all([
    prisma.ticket.count({ where: { guildId, status: { in: ["OPEN", "CLAIMED", "REOPENED"] } } }),
    prisma.order.count({ where: { guildId, status: { in: ["PENDING", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS"] } } }),
    prisma.product.count({ where: { guildId, published: true } }),
    prisma.customer.count({ where: { guildId } }),
  ]);

  const stats = [
    { label: "Open tickets", value: openTickets },
    { label: "Lopende orders", value: pendingOrders },
    { label: "Gepubliceerde producten", value: products },
    { label: "Klanten", value: customers },
  ];

  return (
    <DashboardShell guildId={guildId} access={access}>
      <h1 style={{ marginTop: 0 }}>Overview</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem" }}>
        {stats.map((s) => (
          <div key={s.label} style={{ background: "#151517", border: "1px solid #222", borderRadius: "10px", padding: "1.25rem" }}>
            <div style={{ fontSize: "2rem", fontWeight: 700, color: "#c9a227" }}>{s.value}</div>
            <div style={{ color: "#999", fontSize: "0.85rem" }}>{s.label}</div>
          </div>
        ))}
      </div>
    </DashboardShell>
  );
};
