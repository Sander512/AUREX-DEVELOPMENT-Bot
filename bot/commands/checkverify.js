// bot/commands/checkverify.js
const { SlashCommandBuilder, MessageFlags, AttachmentBuilder } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

const EMBED_DISPLAY_LIMIT = 30; // above this, send a .txt file instead

module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkverify')
    .setDescription('[Staff] Bekijk hoeveel/welke leden geverifieerd zijn'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let config;
    try {
      ({ config } = await api.getVerifyConfig(interaction.guildId));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
      return;
    }

    const roleIds = config.roleIds || [];
    if (roleIds.length === 0) {
      await interaction.editReply({
        embeds: [embeds.warning('Nog niet ingesteld', 'Er is nog geen verificatie-rol ingesteld.')],
      });
      return;
    }

    const roles = [];
    for (const roleId of roleIds) {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (role) roles.push(role);
    }

    if (roles.length === 0) {
      await interaction.editReply({
        embeds: [embeds.error('Rol niet gevonden', 'De ingestelde verificatie-rol(len) bestaan niet meer.')],
      });
      return;
    }

    // Make sure the member cache is populated before reading role.members.
    await interaction.guild.members.fetch().catch(() => {});
    // Union across all verify-rollen — iemand telt als geverifieerd zodra
    // ze minstens één van de ingestelde rollen hebben.
    const memberMap = new Map();
    for (const role of roles) {
      for (const m of role.members.values()) memberMap.set(m.id, m);
    }
    const members = [...memberMap.values()];

    if (members.length === 0) {
      await interaction.editReply({
        embeds: [embeds.info('Geen geverifieerde leden', `Nog niemand heeft de verificatie-rol${roles.length > 1 ? 'len' : ''} ${roles.join(', ')}.`)],
      });
      return;
    }

    if (members.length <= EMBED_DISPLAY_LIMIT) {
      const lines = members.map((m) => `${m.user.tag} — <@${m.id}>`);
      await interaction.editReply({
        embeds: [embeds.info(`Geverifieerde leden (${members.length})`, lines.join('\n'))],
      });
      return;
    }

    const lines = members.map((m) => `${m.id}\t${m.user.tag}`);
    const fileContent = `DiscordID\tUsername\n${lines.join('\n')}`;
    const attachment = new AttachmentBuilder(Buffer.from(fileContent, 'utf-8'), {
      name: `aurex-geverifieerd-${Date.now()}.txt`,
    });

    await interaction.editReply({
      embeds: [embeds.info(`Geverifieerde leden (${members.length})`, 'De lijst is te groot voor een embed — zie het bijgevoegde bestand.')],
      files: [attachment],
    });
  },
};
