// bot/handlers/giveawayInteractions.js
// Handles the two giveaway interactions that don't go through a normal
// slash command: submitting the "Create a Giveaway" modal, and clicking
// the 🎉 "Meedoen" button on a posted giveaway.

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const {
  ENTER_BUTTON_PREFIX,
  parseDuration,
  buildGiveawayEmbed,
  buildGiveawayButtonRow,
} = require('../utils/giveaways');

const CREATE_MODAL_PREFIX = 'giveaway_create:';

/** Builds the "Create a Giveaway" modal, matching GiveawayBot's own form. */
function buildGiveawayModal(channelId, requiredRoleId) {
  const modal = new ModalBuilder()
    .setCustomId(`${CREATE_MODAL_PREFIX}${channelId}:${requiredRoleId || 'none'}`)
    .setTitle('Create a Giveaway');

  const duration = new TextInputBuilder()
    .setCustomId('duration')
    .setLabel('Duration')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Ex: 10 minutes')
    .setRequired(true)
    .setMaxLength(32);

  const winners = new TextInputBuilder()
    .setCustomId('winners')
    .setLabel('Number of Winners')
    .setStyle(TextInputStyle.Short)
    .setValue('1')
    .setRequired(true)
    .setMaxLength(2);

  const prize = new TextInputBuilder()
    .setCustomId('prize')
    .setLabel('Prize')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);

  const description = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(duration),
    new ActionRowBuilder().addComponents(winners),
    new ActionRowBuilder().addComponents(prize),
    new ActionRowBuilder().addComponents(description)
  );

  return modal;
}

async function handleCreateModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [, channelId, roleIdRaw] = interaction.customId.split(':');
  const requiredRoleId = roleIdRaw && roleIdRaw !== 'none' ? roleIdRaw : null;

  const durationInput = interaction.fields.getTextInputValue('duration');
  const winnersInput = interaction.fields.getTextInputValue('winners');
  const prize = interaction.fields.getTextInputValue('prize').trim();
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  const durationMs = parseDuration(durationInput);
  if (!durationMs) {
    await interaction.editReply({
      embeds: [embeds.error('Ongeldige duur', 'Gebruik bijvoorbeeld `10 minutes`, `1d`, `2h30m` of `45m`.')],
    });
    return;
  }

  const winnerCount = Number(winnersInput);
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 50) {
    await interaction.editReply({
      embeds: [embeds.error('Ongeldig aantal winnaars', 'Vul een getal tussen 1 en 50 in.')],
    });
    return;
  }

  const channel = (await interaction.guild.channels.fetch(channelId).catch(() => null)) ?? interaction.channel;

  const botMember = interaction.guild.members.me;
  if (!channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    await interaction.editReply({
      embeds: [embeds.error('Geen rechten', `Ik heb "Bericht sturen" nodig in ${channel}.`)],
    });
    return;
  }

  const endsAt = Date.now() + durationMs;

  const embed = buildGiveawayEmbed({
    prize,
    description,
    winnerCount,
    hostId: interaction.user.id,
    requiredRoleId,
    endsAt,
    ended: false,
    entryCount: 0,
  });

  const message = await channel.send({ embeds: [embed] });

  let giveawayId;
  try {
    const result = await api.createGiveaway({
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: message.id,
      prize,
      description,
      winnerCount,
      hostId: interaction.user.id,
      requiredRoleId,
      endsAt,
    });
    giveawayId = result.id;
  } catch (err) {
    await message.delete().catch(() => {});
    await interaction.editReply({ embeds: [embeds.error('Starten mislukt', err.message)] });
    return;
  }

  await message.edit({ components: [buildGiveawayButtonRow(giveawayId, false)] }).catch(() => {});

  await interaction.editReply({ embeds: [embeds.success('Giveaway gestart', `De giveaway voor **${prize}** loopt nu in ${channel}.`)] });
}

async function handleEnterButton(interaction) {
  const giveawayId = Number(interaction.customId.slice(ENTER_BUTTON_PREFIX.length));
  if (!Number.isInteger(giveawayId)) return;

  let giveaway;
  try {
    ({ giveaway } = await api.getGiveaway(giveawayId));
  } catch {
    await interaction.reply({ embeds: [embeds.error('Niet gevonden', 'Deze giveaway bestaat niet meer.')], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!giveaway || giveaway.status !== 'active') {
    await interaction.reply({ embeds: [embeds.error('Afgelopen', 'Deze giveaway is niet meer actief.')], flags: MessageFlags.Ephemeral });
    return;
  }

  if (giveaway.requiredRoleId && !interaction.member?.roles?.cache?.has(giveaway.requiredRoleId)) {
    await interaction.reply({
      embeds: [embeds.error('Vereiste rol ontbreekt', `Je hebt <@&${giveaway.requiredRoleId}> nodig om mee te doen.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let entered, count;
  try {
    ({ entered, count } = await api.enterGiveaway(giveawayId, interaction.user.id));
  } catch (err) {
    await interaction.reply({ embeds: [embeds.error('Mislukt', err.message)], flags: MessageFlags.Ephemeral });
    return;
  }

  const updatedEmbed = buildGiveawayEmbed({
    prize: giveaway.prize,
    description: giveaway.description,
    winnerCount: giveaway.winnerCount,
    hostId: giveaway.hostId,
    requiredRoleId: giveaway.requiredRoleId,
    endsAt: giveaway.endsAt,
    ended: false,
    entryCount: count,
  });

  // interaction.update() edits the giveaway message itself (new entry
  // count) and acknowledges the button click in one go — no extra
  // ephemeral popup, same as how GiveawayBot's own button behaves.
  try {
    await interaction.update({ embeds: [updatedEmbed] });
  } catch (err) {
    logger.warn(`Kon giveaway-bericht niet bijwerken: ${err.message}`);
  }
}

function isGiveawayInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId.startsWith(CREATE_MODAL_PREFIX)) return true;
  if (interaction.isButton() && interaction.customId.startsWith(ENTER_BUTTON_PREFIX)) return true;
  return false;
}

async function handleGiveawayInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId.startsWith(CREATE_MODAL_PREFIX)) {
    return handleCreateModalSubmit(interaction);
  }
  if (interaction.isButton() && interaction.customId.startsWith(ENTER_BUTTON_PREFIX)) {
    return handleEnterButton(interaction);
  }
}

module.exports = { buildGiveawayModal, isGiveawayInteraction, handleGiveawayInteraction };
