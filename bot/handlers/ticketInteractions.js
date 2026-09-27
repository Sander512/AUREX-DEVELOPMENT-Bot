// bot/handlers/ticketInteractions.js
const {
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { closeTicketChannel, canManageTickets } = require('../utils/ticketActions');
const {
  hexToInt,
  formatTemplate,
  sanitizeChannelName,
  ticketControlRow,
} = require('../utils/tickets');

const DESCRIBE_MODAL_PREFIX = 'ticket_describe:';

/**
 * Everything that happens once we know which type is being opened and
 * (optionally) the description the user typed in the modal. Shared by
 * both the "ask for a description first" flow and the plain flow.
 */
async function createTicketChannel({ interaction, type, config, description }) {
  const guild = interaction.guild;

  const { count } = await api.getOpenTicketCount(
    interaction.guildId,
    interaction.user.id,
    type.maxOpenOverride ? type.key : undefined
  );
  const limit = type.maxOpenOverride || config.maxOpenPerUser;

  if (count >= limit) {
    await interaction.editReply({
      embeds: [
        embeds.warning(
          'Limiet bereikt',
          type.maxOpenOverride
            ? `Je hebt al ${count} open ticket(s) van het type **${type.label}**. Sluit er eerst een voordat je een nieuwe opent.`
            : `Je hebt al ${count} open ticket(s). Sluit een bestaand ticket voordat je een nieuwe opent.`
        ),
      ],
    });
    return;
  }

  const categoryId = type.categoryId || config.categoryId;
  const supportRoleId = type.supportRoleId || config.supportRoleId;
  const nameFormat = type.nameFormat || config.nameFormat;
  const welcomeTemplate = type.welcomeMessage || config.welcomeMessage;

  const channelName = sanitizeChannelName(
    formatTemplate(nameFormat, { number: config.ticketCounter + 1, user: interaction.user.username, type: type.key })
  );

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: interaction.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (supportRoleId) {
    overwrites.push({
      id: supportRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites: overwrites,
    topic: `Ticket geopend door ${interaction.user.tag} (${interaction.user.id}) — type: ${type.label}`,
  });

  const { ticketNumber } = await api.createTicketRecord({
    guildId: interaction.guildId,
    channelId: channel.id,
    openerId: interaction.user.id,
    typeKey: type.key,
    typeLabel: type.label,
  });

  // "Ticket Information" block — category / creator / date, in the same
  // spirit as a classic support-ticket panel, plus the user's own
  // description of their issue when the type asks for one.
  const infoFields = [];
  if (config.showTicketInfo !== false) {
    infoFields.push(
      { name: 'Ticket Category', value: type.label, inline: true },
      { name: 'Ticket Creator', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Date', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    );
  }
  if (description) {
    infoFields.push({ name: 'Waar gaat het over', value: description.slice(0, 1024) });
  }

  const welcomeEmbed = embeds.custom({
    title: `${type.emoji ? `${type.emoji} ` : '🎫 '}Ticket #${String(ticketNumber).padStart(4, '0')} — ${type.label}`,
    description: formatTemplate(welcomeTemplate, { user: `<@${interaction.user.id}>`, type: type.label }),
    color: hexToInt(config.panelColor),
    footer: config.panelFooter,
    fields: infoFields,
  });

  const controlRow = ticketControlRow({ claimEnabled: type.claimEnabled, closeEnabled: type.closeEnabled });
  await channel.send({ embeds: [welcomeEmbed], components: controlRow ? [controlRow] : [] });

  if (config.pingSupportRole && supportRoleId) {
    const ping = await channel.send({ content: `<@&${supportRoleId}>` });
    await ping.delete().catch(() => {});
  }

  await interaction.editReply({ embeds: [embeds.success('Ticket aangemaakt', `Je ticket is geopend: ${channel}`)] });

  await logger.auditLog(interaction.client, {
    action: 'TICKET_OPEN',
    discordId: interaction.user.id,
    details: `Ticket #${ticketNumber} (${type.label}) geopend in ${channel.name}`,
  });
}

async function handleTicketSelect(interaction) {
  const typeKey = interaction.values[0];

  try {
    const { types } = await api.getTicketConfig(interaction.guildId);
    const type = types.find((t) => t.key === typeKey);

    if (!type) {
      await interaction.reply({
        embeds: [embeds.error('Onbekend type', 'Dit ticket-type bestaat niet meer. Vraag een teamlid het panel te vernieuwen.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Types can ask the opener to describe their issue up front (shown
    // later as "Waar gaat het over" in the ticket). That requires a modal,
    // and a modal must be the *first* response to this interaction — so
    // this branch can't defer/reply first like the rest of the flow.
    if (type.askDescription) {
      const modal = new ModalBuilder().setCustomId(`${DESCRIBE_MODAL_PREFIX}${type.key}`).setTitle('Ticket openen');
      const input = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Waar gaat het over?')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true)
        .setPlaceholder('Beschrijf kort je vraag of probleem...');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { config } = await api.getTicketConfig(interaction.guildId);
    await createTicketChannel({ interaction, type, config, description: null });
  } catch (err) {
    logger.error(`Ticket aanmaken mislukt: ${err.message}`);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embeds.error('Aanmaken mislukt', err.message)] });
    } else {
      await interaction.reply({ embeds: [embeds.error('Aanmaken mislukt', err.message)], flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleDescribeModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const typeKey = interaction.customId.slice(DESCRIBE_MODAL_PREFIX.length);
  const description = interaction.fields.getTextInputValue('description');

  try {
    const { config, types } = await api.getTicketConfig(interaction.guildId);
    const type = types.find((t) => t.key === typeKey);

    if (!type) {
      await interaction.editReply({ embeds: [embeds.error('Onbekend type', 'Dit ticket-type bestaat niet meer. Vraag een teamlid het panel te vernieuwen.')] });
      return;
    }

    await createTicketChannel({ interaction, type, config, description });
  } catch (err) {
    logger.error(`Ticket aanmaken mislukt: ${err.message}`);
    await interaction.editReply({ embeds: [embeds.error('Aanmaken mislukt', err.message)] });
  }
}

/** Looks up the ticket-type config for a given ticket record, if it still exists. */
async function findTypeForTicket(guildId, ticket) {
  if (!ticket.typeKey) return null;
  const { types } = await api.getTicketConfig(guildId);
  return types.find((t) => t.key === ticket.typeKey) || null;
}

async function handleClaimButton(interaction) {
  if (!canManageTickets(interaction)) {
    await interaction.reply({ embeds: [embeds.error('Geen toestemming', 'Alleen teamleden kunnen tickets claimen.')], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  try {
    const ticket = await api.getTicketByChannel(interaction.channelId);
    const type = await findTypeForTicket(interaction.guildId, ticket);

    if (type && type.claimEnabled === false) {
      await interaction.editReply({ embeds: [embeds.error('Niet beschikbaar', 'Claimen is uitgeschakeld voor dit ticket-type.')] });
      return;
    }

    await api.claimTicket(interaction.channelId, interaction.user.id);

    const row = ticketControlRow({ claimed: true, claimEnabled: type?.claimEnabled, closeEnabled: type?.closeEnabled });
    await interaction.message.edit({ components: row ? [row] : [] }).catch(() => {});

    await interaction.editReply({
      embeds: [embeds.success('Ticket geclaimd', `🙋 <@${interaction.user.id}> behandelt dit ticket (#${String(ticket.ticketNumber).padStart(4, '0')}).`)],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Claimen mislukt', err.message)] });
  }
}

async function handleCloseButton(interaction) {
  await interaction.deferReply();

  try {
    const ticket = await api.getTicketByChannel(interaction.channelId);
    const type = await findTypeForTicket(interaction.guildId, ticket);

    if (type && type.closeEnabled === false) {
      await interaction.editReply({ embeds: [embeds.error('Niet beschikbaar', 'Sluiten via deze knop is uitgeschakeld voor dit ticket-type. Vraag een teamlid met `/ticket-close`.')] });
      return;
    }

    const { config } = await api.getTicketConfig(interaction.guildId);
    const supportRoleId = type?.supportRoleId || config.supportRoleId;
    const hasSupportRole = supportRoleId ? (interaction.member?.roles?.cache?.has(supportRoleId) ?? false) : false;

    const isOpener = interaction.user.id === ticket.openerId;
    if (!isOpener && !hasSupportRole && !canManageTickets(interaction)) {
      await interaction.editReply({ embeds: [embeds.error('Geen toestemming', 'Alleen de opener of een teamlid kan dit ticket sluiten.')] });
      return;
    }

    await closeTicketChannel({
      interaction,
      channel: interaction.channel,
      ticket,
      config,
      closedBy: interaction.user,
      reason: 'Gesloten via paneel',
    });

    const row = ticketControlRow({ closed: true, claimEnabled: type?.claimEnabled, closeEnabled: type?.closeEnabled });
    await interaction.message.edit({ components: row ? [row] : [] }).catch(() => {});
    await interaction.editReply({ embeds: [embeds.success('Ticket gesloten', 'Het kanaal is vergrendeld en de transcript is opgeslagen.')] });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Sluiten mislukt', err.message)] });
  }
}

async function handleDeleteButton(interaction) {
  if (!canManageTickets(interaction)) {
    await interaction.reply({ embeds: [embeds.error('Geen toestemming', 'Alleen teamleden kunnen ticket-kanalen verwijderen.')], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ embeds: [embeds.info('Kanaal wordt verwijderd', 'Dit ticket-kanaal wordt over enkele seconden verwijderd...')] });

  setTimeout(() => {
    interaction.channel.delete().catch((err) => logger.warn(`Kon ticket-kanaal niet verwijderen: ${err.message}`));
  }, 3000);
}

/** Entry point called from bot/index.js's interactionCreate handler. */
async function handleTicketInteraction(interaction) {
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_panel_select') {
    return handleTicketSelect(interaction);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(DESCRIBE_MODAL_PREFIX)) {
    return handleDescribeModalSubmit(interaction);
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_claim') return handleClaimButton(interaction);
    if (interaction.customId === 'ticket_close') return handleCloseButton(interaction);
    if (interaction.customId === 'ticket_delete') return handleDeleteButton(interaction);
  }

  return false;
}

function isTicketInteraction(interaction) {
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_panel_select') return true;
  if (interaction.isModalSubmit() && interaction.customId.startsWith(DESCRIBE_MODAL_PREFIX)) return true;
  if (interaction.isButton() && ['ticket_claim', 'ticket_close', 'ticket_delete'].includes(interaction.customId)) return true;
  return false;
}

module.exports = { handleTicketInteraction, isTicketInteraction };
