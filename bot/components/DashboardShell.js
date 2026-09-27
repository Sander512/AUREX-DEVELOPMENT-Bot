const Sidebar = require("./Sidebar").default;

export default function DashboardShell({ guildId, access, children }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar guildId={guildId} role={access.role} permissions={access.permissions} />
      <div style={{ flex: 1, padding: "2rem" }}>{children}</div>
    </div>
  );
}

export function NoAccess() {
  return (
    <main style={{ padding: "3rem", textAlign: "center" }}>
      <h2>Geen toegang</h2>
      <p style={{ color: "#999" }}>
        Je hebt geen staff-rol op deze server, of de bot zit hier niet in. Neem contact op met een beheerder als dit
        niet klopt.
      </p>
    </main>
  );
}
