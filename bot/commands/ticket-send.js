// bot/commands/ticket-send.js
const {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  ActionRowBuilder,
} = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { hexToInt } = require('../utils/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-send')
    .setDescription('[Management] Verstuur (of ververs) het ticket panel in een kanaal')
    .addChannelOption((opt) =>
      opt
        .setName('kanaal')
        .setDescription('Kanaal waar het panel geplaatst wordt')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('kanaal', true);

    try {
      const { config, types } = await api.getTicketConfig(interaction.guildId);

      if (!config.categoryId) {
        await interaction.editReply({
          embeds: [embeds.warning('Nog niet volledig ingesteld', 'Stel eerst een categorie in met `/ticket-setup` voordat je het panel verstuurt (anders weet de bot niet waar ticket-kanalen moeten komen).')],
        });
        return;
      }

      if (types.length === 0) {
        await interaction.editReply({
          embeds: [embeds.warning('Geen ticket-types', 'Voeg eerst minstens één ticket-type toe met `/ticket-addtype` voordat je het panel verstuurt.')],
        });
        return;
      }

      const panelEmbed = embeds.custom({
        title: config.panelTitle,
        description: config.panelDescription,
        color: hexToInt(config.panelColor),
        image: config.panelImage,
        thumbnail: config.panelThumbnail,
        footer: config.panelFooter,
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('ticket_panel_select')
        .setPlaceholder('📩 Kies een onderwerp om een ticket te openen')
        .addOptions(
          types.map((t) => ({
            label: t.label,
            value: t.key,
            description: t.description || undefined,
            emoji: t.emoji || undefined,
          }))
        );

      const row = new ActionRowBuilder().addComponents(select);

      await channel.send({ embeds: [panelEmbed], components: [row] });

      await interaction.editReply({
        embeds: [embeds.success('Panel verstuurd', `Het ticket panel staat nu in ${channel}.`)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Versturen mislukt', err.message)] });
    }
  },
};
