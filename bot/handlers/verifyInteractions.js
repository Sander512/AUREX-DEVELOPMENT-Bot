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

  if (!config.roleId) {
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

  if (member.roles.cache.has(config.roleId)) {
    await interaction.editReply({
      embeds: [embeds.info('Al geverifieerd', 'Je bent al geverifieerd op deze server.')],
    });
    return;
  }

  const role = await interaction.guild.roles.fetch(config.roleId).catch(() => null);
  if (!role) {
    await interaction.editReply({
      embeds: [embeds.error('Rol niet gevonden', 'De ingestelde verificatie-rol bestaat niet meer. Vraag een beheerder dit opnieuw in te stellen.')],
    });
    return;
  }

  try {
    await member.roles.add(role);
  } catch (err) {
    await interaction.editReply({
      embeds: [
        embeds.error(
          'Kon rol niet toekennen',
          'De bot heeft geen rechten om deze rol toe te kennen. Controleer of de bot-rol boven de verificatierol staat.'
        ),
      ],
    });
    return;
  }

  await interaction.editReply({
    embeds: [embeds.success('Geverifieerd!', `Je hebt nu de rol ${role} en toegang tot de server.`)],
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
