// bot/commands/shutdown.js
// Gracefully stops the bot process. On a host like Render (configured to
// auto-restart the service), this doubles as a clean "restart the bot"
// button — the process exits, the platform brings it back up fresh.

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('[Management] Sluit de bot netjes af (herstart op hosts die dat automatisch doen)'),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    await interaction.editReply({
      embeds: [embeds.warning('Bot wordt afgesloten', 'De bot sluit nu af. Op Render (of vergelijkbare hosting) start deze automatisch weer op.')],
    });

    await logger.auditLog(client, {
      action: 'SHUTDOWN',
      discordId: interaction.user.id,
      details: `Uitgevoerd door <@${interaction.user.id}>`,
    });

    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 1500);
  },
};
