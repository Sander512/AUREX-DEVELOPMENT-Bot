// bot/commands/welcome-test.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { buildWelcomePayload } = require('../utils/welcome');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('welcome-test')
    .setDescription('[Management] Stuur een testversie van het welkomstbericht naar het ingestelde kanaal'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let config;
    try {
      ({ config } = await api.getWelcomeConfig(interaction.guildId));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
      return;
    }

    if (!config.channelId) {
      await interaction.editReply({
        embeds: [embeds.warning('Geen kanaal ingesteld', 'Stel eerst een welkomst-kanaal in via het dashboard.')],
      });
      return;
    }

    const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
    if (!channel) {
      await interaction.editReply({ embeds: [embeds.error('Kanaal niet gevonden', 'Het ingestelde welkomst-kanaal bestaat niet meer.')] });
      return;
    }

    const payload = buildWelcomePayload(config, interaction.member);
    if (!payload.content && !payload.embeds) {
      await interaction.editReply({
        embeds: [embeds.warning('Niets om te versturen', 'Zowel de tekst als de embed staan uit — er is niets te versturen.')],
      });
      return;
    }

    await channel.send(payload);
    await interaction.editReply({ embeds: [embeds.success('Testbericht verstuurd', `Bekijk het resultaat in ${channel}.`)] });
  },
};
