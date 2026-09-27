const { prisma } = require("../../../lib/prisma");
const { requirePageAccess } = require("../../../lib/pageGuard");
const { canDo } = require("../../../lib/permissions");
const DashboardShell = require("../../../components/DashboardShell").default;
const { NoAccess } = require("../../../components/DashboardShell");
const ProductForm = require("../../../components/ProductForm").default;

module.exports = async function ProductsPage({ searchParams }) {
  const guildId = searchParams.guild;
  const { access } = await requirePageAccess(guildId);

  if (!access) return <NoAccess />;
  if (!canDo(access, "manageProducts")) {
    return (
      <DashboardShell guildId={guildId} access={access}>
        <p style={{ color: "#999" }}>Je hebt geen rechten om producten te beheren.</p>
      </DashboardShell>
    );
  }

  const products = await prisma.product.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <DashboardShell guildId={guildId} access={access}>
      <h1 style={{ marginTop: 0 }}>Products</h1>
      <ProductForm guildId={guildId} />

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#999", fontSize: "0.8rem" }}>
            <th style={{ padding: "0.5rem" }}>Naam</th>
            <th style={{ padding: "0.5rem" }}>Categorie</th>
            <th style={{ padding: "0.5rem" }}>Prijs</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} style={{ borderTop: "1px solid #222" }}>
              <td style={{ padding: "0.5rem" }}>{p.name}</td>
              <td style={{ padding: "0.5rem", color: "#999" }}>{p.category}</td>
              <td style={{ padding: "0.5rem" }}>€{(p.priceCents / 100).toFixed(2)}</td>
              <td style={{ padding: "0.5rem" }}>{p.published ? "Gepubliceerd" : "Concept"}</td>
            </tr>
          ))}
          {products.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: "1rem", color: "#666" }}>
                Nog geen producten.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </DashboardShell>
  );
};
