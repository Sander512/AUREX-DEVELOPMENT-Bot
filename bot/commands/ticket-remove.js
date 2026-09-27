// bot/commands/ticket-remove.js
const { SlashCommandBuilder } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-remove')
    .setDescription('[Staff] Verwijder een lid uit het huidige ticket')
    .addUserOption((opt) => opt.setName('lid').setDescription('Lid om te verwijderen').setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();

    const member = interaction.options.getUser('lid', true);

    try {
      const ticket = await api.getTicketByChannel(interaction.channelId);

      if (member.id === ticket.openerId) {
        await interaction.editReply({ embeds: [embeds.error('Niet toegestaan', 'De opener van het ticket kan niet verwijderd worden.')] });
        return;
      }

      await interaction.channel.permissionOverwrites.delete(member.id);
      await interaction.editReply({ embeds: [embeds.success('Lid verwijderd', `<@${member.id}> heeft geen toegang meer tot dit ticket.`)] });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Verwijderen mislukt', err.message)] });
    }
  },
};
