// bot/commands/unverify.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unverify')
    .setDescription('[Management] Verwijder de verificatie-rol van een lid')
    .addUserOption((opt) =>
      opt.setName('lid').setDescription('Het Discord-lid').setRequired(true)
    ),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser('lid', true);

    let config;
    try {
      ({ config } = await api.getVerifyConfig(interaction.guildId));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
      return;
    }

    if (!config.roleId) {
      await interaction.editReply({
        embeds: [embeds.warning('Nog niet ingesteld', 'Er is nog geen verificatie-rol ingesteld.')],
      });
      return;
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.editReply({ embeds: [embeds.error('Lid niet gevonden', 'Dit lid zit niet (meer) op de server.')] });
      return;
    }

    if (!member.roles.cache.has(config.roleId)) {
      await interaction.editReply({
        embeds: [embeds.info('Niet geverifieerd', `<@${target.id}> heeft de verificatie-rol niet.`)],
      });
      return;
    }

    try {
      await member.roles.remove(config.roleId);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ontkoppelen mislukt', err.message)] });
      return;
    }

    await interaction.editReply({
      embeds: [embeds.success('Ontkoppeld', `De verificatie-rol van <@${target.id}> is verwijderd.`)],
    });

    await logger.auditLog(client, {
      action: 'UNVERIFY',
      discordId: target.id,
      details: `Uitgevoerd door <@${interaction.user.id}>`,
    });
  },
};
