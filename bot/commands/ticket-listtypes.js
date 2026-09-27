// bot/commands/ticket-listtypes.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-listtypes')
    .setDescription('[Management] Toon alle geconfigureerde ticket-types'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { types } = await api.listTicketTypes(interaction.guildId);

      if (types.length === 0) {
        await interaction.editReply({
          embeds: [embeds.info('Geen ticket-types', 'Er zijn nog geen ticket-types toegevoegd. Gebruik `/ticket-addtype` om er een aan te maken.')],
        });
        return;
      }

      const description = types
        .map((t, i) => {
          const flags = [
            t.claimEnabled === false ? '🚫 claim' : null,
            t.closeEnabled === false ? '🚫 sluiten' : null,
            t.askDescription === false ? null : '📝 beschrijving',
            t.maxOpenOverride ? `max ${t.maxOpenOverride}` : null,
          ].filter(Boolean);
          return `**${i + 1}.** ${t.emoji ? `${t.emoji} ` : ''}${t.label} — \`${t.key}\`${t.description ? `\n   ↳ ${t.description}` : ''}${
            flags.length ? `\n   ⚙️ ${flags.join(' · ')}` : ''
          }`;
        })
        .join('\n');

      await interaction.editReply({
        embeds: [embeds.info(`🎫 Ticket-types (${types.length}/25)`, description)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
    }
  },
};
