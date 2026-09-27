const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { ACCENT_COLOR } = require("../../config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check of AUREX DEVELOPMENT online is."),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(ACCENT_COLOR)
      .setDescription(`🏓 Pong! Latency: **${Math.round(interaction.client.ws.ping)}ms**`);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
