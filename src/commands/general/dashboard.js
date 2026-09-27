const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { ACCENT_COLOR } = require("../../config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Open het AUREX DEVELOPMENT dashboard voor deze server."),

  async execute(interaction) {
    const baseUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
    // The dashboard itself re-checks the user's staff role via Discord OAuth2
    // before showing any management page — this link alone grants nothing.
    const url = `${baseUrl}/dashboard?guild=${interaction.guildId}`;

    const embed = new EmbedBuilder()
      .setColor(ACCENT_COLOR)
      .setTitle("AUREX DEVELOPMENT — Dashboard")
      .setDescription("Klik hieronder om het beveiligde dashboard te openen. Je logt in met Discord en ziet alleen de secties waarvoor je rechten hebt.");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Open Dashboard").setStyle(ButtonStyle.Link).setURL(url)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  },
};
