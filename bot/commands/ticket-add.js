// bot/commands/ticket-add.js
const { SlashCommandBuilder } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-add')
    .setDescription('[Staff] Voeg een lid toe aan het huidige ticket')
    .addUserOption((opt) => opt.setName('lid').setDescription('Lid om toe te voegen').setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();

    const member = interaction.options.getUser('lid', true);

    try {
      await api.getTicketByChannel(interaction.channelId);
      await interaction.channel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });

      await interaction.editReply({ embeds: [embeds.success('Lid toegevoegd', `<@${member.id}> heeft nu toegang tot dit ticket.`)] });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Toevoegen mislukt', err.message)] });
    }
  },
};
