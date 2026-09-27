// bot/commands/announce.js
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const embeds = require('../utils/embeds');
const { hexToInt } = require('../utils/tickets');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('[Management] Stuur een aankondiging naar een kanaal')
    .addChannelOption((opt) =>
      opt
        .setName('kanaal')
        .setDescription('Kanaal om de aankondiging in te plaatsen')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addStringOption((opt) => opt.setName('bericht').setDescription('Het bericht').setRequired(true).setMaxLength(4000))
    .addStringOption((opt) => opt.setName('titel').setDescription('Titel boven het bericht (optioneel)').setRequired(false).setMaxLength(256))
    .addBooleanOption((opt) =>
      opt.setName('everyone').setDescription('@everyone pingen (standaard: nee)').setRequired(false)
    ),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('kanaal', true);
    const message = interaction.options.getString('bericht', true);
    const title = interaction.options.getString('titel');
    const pingEveryone = interaction.options.getBoolean('everyone') ?? false;

    const botMember = interaction.guild.members.me;
    if (!channel.permissionsFor(botMember)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      await interaction.editReply({ embeds: [embeds.error('Ontbrekende rechten', `De bot kan niet posten in ${channel}.`)] });
      return;
    }

    const embed = embeds.custom({
      title: title ? `📢 ${title}` : '📢 Aankondiging',
      description: message,
      color: hexToInt('5865f2', 0x5865f2),
    });

    try {
      await channel.send({
        content: pingEveryone ? '@everyone' : undefined,
        embeds: [embed],
        allowedMentions: pingEveryone ? { parse: ['everyone'] } : { parse: [] },
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Versturen mislukt', err.message)] });
      return;
    }

    await interaction.editReply({ embeds: [embeds.success('Aankondiging verstuurd', `Bericht geplaatst in ${channel}.`)] });

    await logger.auditLog(client, {
      action: 'ANNOUNCE',
      discordId: interaction.user.id,
      details: `In ${channel.id}: "${message}"`,
    });
  },
};
