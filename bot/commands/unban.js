// bot/commands/unban.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('[Management] Unban een lid van de server')
    .addStringOption((opt) => opt.setName('discord-id').setDescription('Het Discord ID van de gebruiker').setRequired(true)),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const userId = interaction.options.getString('discord-id', true).trim();

    if (!/^\d{15,25}$/.test(userId)) {
      await interaction.editReply({ embeds: [embeds.error('Ongeldig ID', 'Geef een geldig Discord gebruikers-ID op (alleen cijfers).')] });
      return;
    }

    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.editReply({ embeds: [embeds.error('Ontbrekende rechten', 'De bot heeft geen "Ban Members" rechten op deze server.')] });
      return;
    }

    const banEntry = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!banEntry) {
      await interaction.editReply({ embeds: [embeds.info('Niet gebanned', 'Dit Discord-ID staat niet op de banlijst van deze server.')] });
      return;
    }

    try {
      await interaction.guild.members.unban(userId, `Unban door ${interaction.user.tag}`);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Actie mislukt', err.message)] });
      return;
    }

    await interaction.editReply({
      embeds: [embeds.success('Lid unbanned', `<@${userId}> (${banEntry.user.tag}) is unbanned.`)],
    });

    await logger.auditLog(client, {
      action: 'UNBAN',
      discordId: userId,
      details: `Uitgevoerd door <@${interaction.user.id}>`,
    });
  },
};
