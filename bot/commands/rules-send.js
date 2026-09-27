// bot/commands/rules-send.js
// Posts the dashboard-configured rules embed to the configured channel
// (or a channel passed as an option, which also updates the configured
// channel). If a previous rules message is known, it's edited in place
// instead of posting a duplicate — run this again after changing the
// rules on the dashboard to update the live message.

const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { hexToInt } = require('../utils/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rules-send')
    .setDescription('[Management] Plaats (of werk bij) de regels-embed')
    .addChannelOption((opt) =>
      opt
        .setName('kanaal')
        .setDescription('Kanaal waar de regels geplaatst worden (overschrijft het ingestelde kanaal)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let config;
    try {
      ({ config } = await api.getRulesConfig(interaction.guildId));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
      return;
    }

    const optionChannel = interaction.options.getChannel('kanaal');
    const targetChannelId = optionChannel?.id || config.channelId;

    if (!targetChannelId) {
      await interaction.editReply({
        embeds: [
          embeds.warning(
            'Geen kanaal ingesteld',
            'Stel een kanaal in via het dashboard (tabblad Regels), of geef er hier één mee als optie.'
          ),
        ],
      });
      return;
    }

    const channel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel) {
      await interaction.editReply({ embeds: [embeds.error('Kanaal niet gevonden', 'Het ingestelde regels-kanaal bestaat niet meer.')] });
      return;
    }

    // If the option channel differs from the stored one, save it so the
    // dashboard and future /rules-send runs stay in sync.
    if (optionChannel && optionChannel.id !== config.channelId) {
      await api.updateRulesConfig(interaction.guildId, { channelId: optionChannel.id }).catch(() => {});
    }

    const rulesEmbed = embeds.custom({
      title: config.title,
      description: config.description,
      color: hexToInt(config.color, 0x5865f2),
      image: config.image || undefined,
      footer: config.footer || undefined,
    });

    // Try to edit the previously sent message (if it's still there and in
    // this same channel) so re-running this command doesn't spam duplicates.
    if (config.messageId) {
      const existing = await channel.messages.fetch(config.messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [rulesEmbed] });
        await interaction.editReply({
          embeds: [embeds.success('Regels bijgewerkt', `Het bestaande regels-bericht in ${channel} is bijgewerkt.`)],
        });
        return;
      }
    }

    const sent = await channel.send({ embeds: [rulesEmbed] });
    await api.setRulesMessageId(interaction.guildId, sent.id).catch(() => {});

    await interaction.editReply({
      embeds: [embeds.success('Regels geplaatst', `De regels staan nu in ${channel}.`)],
    });
  },
};
