// bot/commands/kick.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('[Management] Kick een lid van de server')
    .addUserOption((opt) => opt.setName('lid').setDescription('De Discord gebruiker').setRequired(true))
    .addStringOption((opt) => opt.setName('reden').setDescription('Reden voor de kick').setRequired(false).setMaxLength(500)),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser('lid', true);
    const reason = interaction.options.getString('reden') || 'Geen reden opgegeven';

    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
      await interaction.editReply({ embeds: [embeds.error('Ontbrekende rechten', 'De bot heeft geen "Kick Members" rechten op deze server.')] });
      return;
    }

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      await interaction.editReply({ embeds: [embeds.error('Lid niet gevonden', 'Dit lid zit niet (meer) op de server.')] });
      return;
    }

    if (!targetMember.kickable) {
      await interaction.editReply({
        embeds: [embeds.error('Kan niet kicken', 'Dit lid heeft een hogere of gelijke rol dan de bot, of is de server-eigenaar.')],
      });
      return;
    }

    try {
      await targetMember.kick(`${reason} — door ${interaction.user.tag}`);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Actie mislukt', err.message)] });
      return;
    }

    await interaction.editReply({
      embeds: [embeds.success('Lid gekickt', `<@${target.id}> (${target.tag}) is gekickt.\nReden: ${reason}`)],
    });

    await logger.auditLog(client, {
      action: 'KICK',
      discordId: target.id,
      details: `Reden: ${reason} — door <@${interaction.user.id}>`,
    });
  },
};
