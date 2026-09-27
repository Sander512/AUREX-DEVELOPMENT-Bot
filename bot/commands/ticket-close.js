// bot/commands/ticket-close.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { closeTicketChannel } = require('../utils/ticketActions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-close')
    .setDescription('[Staff] Sluit het huidige ticket (voer uit in het ticket-kanaal)')
    .addStringOption((opt) => opt.setName('reden').setDescription('Reden voor het sluiten').setMaxLength(500)),

  async execute(interaction) {
    await interaction.deferReply();

    const reason = interaction.options.getString('reden');

    try {
      const ticket = await api.getTicketByChannel(interaction.channelId);
      const { config } = await api.getTicketConfig(interaction.guildId);

      // /ticket-close is a staff command, so it intentionally bypasses a
      // type's "close via button disabled" setting — that setting only
      // hides the button for the opener, staff can still always close.
      if (config.requireCloseReason && !reason) {
        await interaction.editReply({
          embeds: [embeds.error('Reden verplicht', 'Deze server vereist een reden bij het sluiten. Gebruik `/ticket-close reden:<...>`.')],
        });
        return;
      }

      await closeTicketChannel({
        interaction,
        channel: interaction.channel,
        ticket,
        config,
        closedBy: interaction.user,
        reason: reason || 'Geen reden opgegeven',
      });

      await interaction.editReply({ embeds: [embeds.success('Ticket gesloten', 'Het kanaal is vergrendeld en de transcript is opgeslagen.')] });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Sluiten mislukt', err.message)] });
    }
  },
};
