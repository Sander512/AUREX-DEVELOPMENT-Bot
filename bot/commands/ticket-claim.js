// bot/commands/ticket-claim.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { ticketControlRow } = require('../utils/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-claim')
    .setDescription('[Staff] Claim het huidige ticket (voer uit in het ticket-kanaal)'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const ticket = await api.getTicketByChannel(interaction.channelId);
      const { types } = await api.getTicketConfig(interaction.guildId);
      const type = types.find((t) => t.key === ticket.typeKey);

      if (type && type.claimEnabled === false) {
        await interaction.editReply({ embeds: [embeds.error('Niet beschikbaar', 'Claimen is uitgeschakeld voor dit ticket-type.')] });
        return;
      }

      await api.claimTicket(interaction.channelId, interaction.user.id);

      await interaction.channel.messages
        .fetch({ limit: 20 })
        .then((msgs) => {
          const controlMsg = msgs.find((m) => m.author.id === interaction.client.user.id && m.components.length > 0);
          if (controlMsg) {
            const row = ticketControlRow({ claimed: true, claimEnabled: type?.claimEnabled, closeEnabled: type?.closeEnabled });
            return controlMsg.edit({ components: row ? [row] : [] });
          }
        })
        .catch(() => {});

      await interaction.editReply({
        embeds: [embeds.success('Ticket geclaimd', `🙋 <@${interaction.user.id}> behandelt dit ticket (#${String(ticket.ticketNumber).padStart(4, '0')}).`)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Claimen mislukt', err.message)] });
    }
  },
};
