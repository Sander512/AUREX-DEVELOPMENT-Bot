// bot/commands/ban.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('[Management] Ban een lid van de server')
    .addUserOption((opt) => opt.setName('lid').setDescription('De Discord gebruiker').setRequired(true))
    .addStringOption((opt) => opt.setName('reden').setDescription('Reden voor de ban').setRequired(true).setMaxLength(500))
    .addIntegerOption((opt) =>
      opt
        .setName('berichten-verwijderen')
        .setDescription('Verwijder berichten van de afgelopen X dagen (standaard 0)')
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false)
    ),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser('lid', true);
    const reason = interaction.options.getString('reden', true);
    const deleteDays = interaction.options.getInteger('berichten-verwijderen') ?? 0;

    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.editReply({ embeds: [embeds.error('Ontbrekende rechten', 'De bot heeft geen "Ban Members" rechten op deze server.')] });
      return;
    }

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (targetMember && !targetMember.bannable) {
      await interaction.editReply({
        embeds: [embeds.error('Kan niet bannen', 'Dit lid heeft een hogere of gelijke rol dan de bot, of is de server-eigenaar.')],
      });
      return;
    }

    try {
      await interaction.guild.members.ban(target.id, { reason: `${reason} — door ${interaction.user.tag}`, deleteMessageSeconds: deleteDays * 86400 });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Actie mislukt', err.message)] });
      return;
    }

    await interaction.editReply({
      embeds: [embeds.success('Lid gebanned', `<@${target.id}> (${target.tag}) is gebanned.\nReden: ${reason}`)],
    });

    await logger.auditLog(client, {
      action: 'BAN',
      discordId: target.id,
      details: `Reden: ${reason} — door <@${interaction.user.id}>`,
    });
  },
};
