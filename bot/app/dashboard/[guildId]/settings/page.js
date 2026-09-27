const { getServerSession } = require("next-auth");
const { authOptions } = require("../../../../lib/auth");
const { resolveAccess, canDo } = require("../../../../lib/permissions");
const { prisma } = require("../../../../lib/prisma");
const SettingsForm = require("../../../../components/SettingsForm").default;

module.exports = async function SettingsPage({ params }) {
  const session = await getServerSession(authOptions);
  const access = await resolveAccess(params.guildId, session.discordId);

  if (!canDo(access, "manageSettings")) {
    return <p style={{ color: "#999" }}>Je hebt geen rechten om instellingen te beheren.</p>;
  }

  const settings = await prisma.guildSettings.findUnique({ where: { guildId: params.guildId } });

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Server Settings</h1>
      <SettingsForm guildId={params.guildId} initial={settings || {}} />
    </div>
  );
};
