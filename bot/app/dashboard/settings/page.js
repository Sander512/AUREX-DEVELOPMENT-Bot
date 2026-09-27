const { prisma } = require("../../../lib/prisma");
const { requirePageAccess } = require("../../../lib/pageGuard");
const { canDo } = require("../../../lib/permissions");
const DashboardShell = require("../../../components/DashboardShell").default;
const { NoAccess } = require("../../../components/DashboardShell");
const SettingsForm = require("../../../components/SettingsForm").default;

module.exports = async function SettingsPage({ searchParams }) {
  const guildId = searchParams.guild;
  const { access } = await requirePageAccess(guildId);

  if (!access) return <NoAccess />;
  if (!canDo(access, "manageSettings")) {
    return (
      <DashboardShell guildId={guildId} access={access}>
        <p style={{ color: "#999" }}>Je hebt geen rechten om instellingen te beheren.</p>
      </DashboardShell>
    );
  }

  const settings = await prisma.guildSettings.findUnique({ where: { guildId } });

  return (
    <DashboardShell guildId={guildId} access={access}>
      <h1 style={{ marginTop: 0 }}>Server Settings</h1>
      <SettingsForm guildId={guildId} initial={settings || {}} />
    </DashboardShell>
  );
};
