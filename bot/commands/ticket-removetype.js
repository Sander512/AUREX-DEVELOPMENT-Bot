// bot/commands/ticket-removetype.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-removetype')
    .setDescription('[Management] Verwijder een ticket-type uit het panel')
    .addStringOption((opt) =>
      opt.setName('key').setDescription('Het ticket-type om te verwijderen').setRequired(true).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();

    try {
      const { types } = await api.listTicketTypes(interaction.guildId);
      const filtered = types
        .filter((t) => t.key.includes(focused) || t.label.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((t) => ({ name: `${t.label} (${t.key})`, value: t.key }));

      await interaction.respond(filtered);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const key = interaction.options.getString('key', true);

    try {
      await api.removeTicketType(interaction.guildId, key);
      await interaction.editReply({
        embeds: [embeds.success('Ticket type verwijderd', `\`${key}\` is verwijderd uit het panel.\nGebruik \`/ticket-send\` om het bijgewerkte panel te versturen.`)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Verwijderen mislukt', err.message)] });
    }
  },
};
