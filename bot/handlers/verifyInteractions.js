// bot/handlers/verifyInteractions.js
// One-click verify flow: member clicks a button, the bot grants the role
// configured for that server via the dashboard (or /verify-panel). No
// external account, code or modal is involved.

const { MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

const BUTTON_ID = 'verify_direct_button';

function isVerifyInteraction(interaction) {
  return interaction.isButton() && interaction.customId === BUTTON_ID;
}

async function handleVerifyInteraction(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let config;
  try {
    ({ config } = await api.getVerifyConfig(interaction.guildId));
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Verifiëren mislukt', err.message)] });
    return;
  }

  const roleIds = config.roleIds || [];

  if (roleIds.length === 0) {
    await interaction.editReply({
      embeds: [
        embeds.warning(
          'Nog niet ingesteld',
          'Er is nog geen verificatie-rol ingesteld. Vraag een beheerder om dit via het dashboard of `/verify-panel` te configureren.'
        ),
      ],
    });
    return;
  }

  const member = interaction.member;

  if (roleIds.every((id) => member.roles.cache.has(id))) {
    await interaction.editReply({
      embeds: [embeds.info('Al geverifieerd', 'Je bent al geverifieerd op deze server.')],
    });
    return;
  }

  const roles = [];
  const missingRoleIds = [];
  for (const roleId of roleIds) {
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (role) roles.push(role);
    else missingRoleIds.push(roleId);
  }

  if (roles.length === 0) {
    await interaction.editReply({
      embeds: [embeds.error('Rol niet gevonden', 'De ingestelde verificatie-rol(len) bestaan niet meer. Vraag een beheerder dit opnieuw in te stellen.')],
    });
    return;
  }

  try {
    await member.roles.add(roles);
  } catch (err) {
    await interaction.editReply({
      embeds: [
        embeds.error(
          'Kon rol niet toekennen',
          'De bot heeft geen rechten om deze rol(len) toe te kennen. Controleer of de bot-rol boven de verificatierol(len) staat.'
        ),
      ],
    });
    return;
  }

  const roleMentions = roles.map((r) => `${r}`).join(', ');
  const missingNote =
    missingRoleIds.length > 0
      ? '\n\n⚠️ Eén of meer ingestelde rollen bestaan niet meer en zijn overgeslagen — vraag een beheerder dit bij te werken.'
      : '';

  await interaction.editReply({
    embeds: [embeds.success('Geverifieerd!', `Je hebt nu de rol${roles.length > 1 ? 'len' : ''} ${roleMentions} en toegang tot de server.${missingNote}`)],
  });

  if (config.logChannelId) {
    const logChannel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
    if (logChannel?.isTextBased()) {
      await logChannel
        .send({ embeds: [embeds.audit({ action: 'VERIFY', discordId: interaction.user.id, details: `Rol ${role.name} toegekend` })] })
        .catch((err) => logger.warn(`Kon verify-log niet versturen: ${err.message}`));
    }
  }
}

module.exports = { isVerifyInteraction, handleVerifyInteraction, BUTTON_ID };
