// bot/commands/ticket-list.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-list')
    .setDescription('[Staff] Toon alle open tickets'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { tickets } = await api.listTickets(interaction.guildId);
      const open = tickets.filter((t) => t.status !== 'closed');

      if (open.length === 0) {
        await interaction.editReply({ embeds: [embeds.info('Geen open tickets', 'Er zijn momenteel geen open tickets.')] });
        return;
      }

      const description = open
        .map((t) => `#${String(t.ticketNumber).padStart(4, '0')} — <#${t.channelId}> — <@${t.openerId}>${t.claimedBy ? ` — geclaimd door <@${t.claimedBy}>` : ''}${t.typeLabel ? ` — *${t.typeLabel}*` : ''}`)
        .join('\n');

      await interaction.editReply({ embeds: [embeds.info(`🎫 Open tickets (${open.length})`, description)] });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
    }
  },
};
