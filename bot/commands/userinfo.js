// bot/commands/userinfo.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const embeds = require('../utils/embeds');
const api = require('../utils/api');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Bekijk informatie over een lid')
    .addUserOption((opt) => opt.setName('lid').setDescription('De Discord gebruiker (standaard: jezelf)').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser('lid') || interaction.user;
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);

    if (!member) {
      await interaction.editReply({ embeds: [embeds.error('Lid niet gevonden', 'Dit lid zit niet (meer) op de server.')] });
      return;
    }

    let verifiedText = 'Onbekend';
    try {
      const { config } = await api.getVerifyConfig(interaction.guildId);
      const roleIds = config.roleIds || [];
      verifiedText = roleIds.length > 0 ? (roleIds.some((id) => member.roles.cache.has(id)) ? 'Ja ✅' : 'Nee ❌') : 'Niet ingesteld';
    } catch {
      // Non-fatal — just show "Onbekend" if the API call fails.
    }

    const roles = member.roles.cache
      .filter((r) => r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `<@&${r.id}>`);

    const embed = embeds
      .custom({ title: `Gebruikersinformatie — ${target.tag}` })
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'Discord', value: `<@${target.id}>`, inline: true },
        { name: 'Geverifieerd', value: verifiedText, inline: true },
        { name: 'Lid geworden op', value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : 'Onbekend', inline: true },
        { name: 'Account aangemaakt op', value: `<t:${Math.floor(target.createdAt.getTime() / 1000)}:D>`, inline: true },
        { name: `Rollen (${roles.length})`, value: roles.length ? roles.join(', ').slice(0, 1024) : 'Geen' }
      );

    await interaction.editReply({ embeds: [embed] });
  },
};
