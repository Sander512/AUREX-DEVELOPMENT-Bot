const { prisma } = require("./prisma");

/**
 * Returns this guild's settings row, creating a default one on first use.
 * Every command/handler should go through this instead of querying
 * GuildSettings directly, so a brand-new server always has a row.
 */
async function getOrCreateGuildSettings(guildId) {
  let settings = await prisma.guildSettings.findUnique({ where: { guildId } });

  if (!settings) {
    settings = await prisma.guildSettings.create({
      data: { guildId },
    });

    // Seed the 7 default ticket categories so the panel works immediately.
    const defaults = [
      { type: "PURCHASE", label: "Purchase" },
      { type: "CUSTOM_DEVELOPMENT", label: "Custom Development" },
      { type: "PRODUCT_SUPPORT", label: "Product Support" },
      { type: "INSTALLATION_SUPPORT", label: "Installation Support" },
      { type: "BUG_REPORT", label: "Bug Report" },
      { type: "BILLING", label: "Billing" },
      { type: "GENERAL_QUESTIONS", label: "General Questions" },
    ];

    await prisma.ticketCategory.createMany({
      data: defaults.map((d) => ({ ...d, guildId })),
    });
  }

  return settings;
}

module.exports = { getOrCreateGuildSettings };
