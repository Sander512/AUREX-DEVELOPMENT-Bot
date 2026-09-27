const links = [
  { href: "", label: "Overview", capability: null },
  { href: "/products", label: "Products", capability: "manageProducts" },
  { href: "/orders", label: "Orders", capability: "manageOrders" },
  { href: "/settings", label: "Server Settings", capability: "manageSettings" },
];

export default function Sidebar({ guildId, role, permissions }) {
  const canSee = (capability) => !capability || permissions.all || permissions[capability];

  return (
    <nav
      style={{
        width: "230px",
        borderRight: "1px solid #222",
        padding: "1.5rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.25rem",
      }}
    >
      <div style={{ fontWeight: 700, letterSpacing: "0.05em", marginBottom: "0.25rem" }}>AUREX</div>
      <div style={{ fontSize: "0.75rem", color: "#c9a227", marginBottom: "1.5rem" }}>{role}</div>

      {links
        .filter((l) => canSee(l.capability))
        .map((l) => (
          <a
            key={l.href}
            href={`/dashboard${l.href}?guild=${guildId}`}
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: "6px",
              color: "#ddd",
              textDecoration: "none",
              fontSize: "0.9rem",
            }}
          >
            {l.label}
          </a>
        ))}
    </nav>
  );
}
