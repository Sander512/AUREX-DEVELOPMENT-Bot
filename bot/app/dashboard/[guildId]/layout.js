const { getServerSession } = require("next-auth");
const { redirect } = require("next/navigation");
const { authOptions } = require("../../../lib/auth");
const { resolveAccess } = require("../../../lib/permissions");
const Sidebar = require("../../../components/Sidebar").default;

module.exports = async function GuildLayout({ children, params }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect(`/api/auth/signin/discord?callbackUrl=/dashboard/${params.guildId}`);
  }

  const access = await resolveAccess(params.guildId, session.discordId);

  if (!access) {
    return (
      <main style={{ padding: "3rem", textAlign: "center" }}>
        <h2>Geen toegang</h2>
        <p style={{ color: "#999" }}>
          Je hebt geen staff-rol op deze server, of de bot zit hier niet in. Neem contact op met een beheerder als
          dit niet klopt.
        </p>
      </main>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar guildId={params.guildId} role={access.role} permissions={access.permissions} />
      <div style={{ flex: 1, padding: "2rem" }}>{children}</div>
    </div>
  );
};
