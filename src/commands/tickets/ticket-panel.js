const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { ACCENT_COLOR } = require("../../config");
const { getOrCreateGuildSettings } = require("../../database/guild");
const { prisma } = require("../../database/prisma");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Plaats het ticketpanel in dit kanaal.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await getOrCreateGuildSettings(interaction.guildId);

    const categories = await prisma.ticketCategory.findMany({
      where: { guildId: interaction.guildId, enabled: true },
    });

    const embed = new EmbedBuilder()
      .setColor(ACCENT_COLOR)
      .setTitle("AUREX DEVELOPMENT — Support")
      .setDescription(
        "Selecteer hieronder een categorie om een ticket te openen. Ons team helpt je zo snel mogelijk."
      );

    const menu = new StringSelectMenuBuilder()
      .setCustomId("aurex:ticket:create")
      .setPlaceholder("Kies een categorie...")
      .addOptions(
        categories.map((c) => ({
          label: c.label,
          value: c.id,
          emoji: c.emoji || undefined,
        }))
      );

    await interaction.channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    await interaction.reply({ content: "Ticketpanel geplaatst.", ephemeral: true });
  },
};
