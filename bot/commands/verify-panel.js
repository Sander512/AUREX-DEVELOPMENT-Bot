// bot/commands/verify-panel.js
const {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { hexToInt } = require('../utils/tickets');
const { BUTTON_ID } = require('../handlers/verifyInteractions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('[Management] Verstuur het verificatie-paneel (knop) in een kanaal')
    .addChannelOption((opt) =>
      opt
        .setName('kanaal')
        .setDescription('Kanaal waar het paneel geplaatst wordt')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('kanaal', true);

    let config;
    try {
      ({ config } = await api.getVerifyConfig(interaction.guildId));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
      return;
    }

    if (!config.roleIds || config.roleIds.length === 0) {
      await interaction.editReply({
        embeds: [
          embeds.warning(
            'Nog geen rol ingesteld',
            'Stel eerst een verificatie-rol in via het dashboard (tabblad Verificatie) voordat je het paneel verstuurt.'
          ),
        ],
      });
      return;
    }

    const panelEmbed = embeds.custom({
      title: config.panelTitle,
      description: config.panelDescription,
      color: hexToInt(config.panelColor, 0x5865f2),
      image: config.panelImage || undefined,
      footer: config.panelFooter || undefined,
    });

    const button = new ButtonBuilder()
      .setCustomId(BUTTON_ID)
      .setLabel(config.buttonLabel || 'Verifiëren')
      .setEmoji('🔐')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await channel.send({ embeds: [panelEmbed], components: [row] });

    await interaction.editReply({
      embeds: [embeds.success('Paneel verstuurd', `Het verificatie-paneel staat nu in ${channel}.`)],
    });
  },
};
