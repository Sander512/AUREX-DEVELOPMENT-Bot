// bot/utils/ticketActions.js
// Logic shared between the /ticket-close, /ticket-claim slash commands and
// the buttons on the ticket panel/control message, so both stay in sync.

const { PermissionFlagsBits } = require('discord.js');
const api = require('./api');
const embeds = require('./embeds');
const logger = require('./logger');
const { generateTranscript, ticketDeleteRow, hexToInt } = require('./tickets');

/**
 * Locks a ticket channel, records the close in the database, generates a
 * transcript and posts it to the configured log/transcript channel.
 */
async function closeTicketChannel({ channel, ticket, config, closedBy, reason }) {
  await api.closeTicket(channel.id, closedBy.id, reason);

  // Prevent the opener (and anyone without manage-channel perms) from
  // posting further, but keep the channel visible so history can be read.
  await channel.permissionOverwrites
    .edit(ticket.openerId, { SendMessages: false, AddReactions: false })
    .catch(() => {});

  const transcript = await generateTranscript(channel, { ticketNumber: ticket.ticketNumber }).catch(() => null);

  const closedEmbed = embeds
    .custom({
      title: '🔒 Ticket gesloten',
      color: hexToInt(config.panelColor, 0xef4444),
      fields: [
        { name: 'Gesloten door', value: `<@${closedBy.id}>`, inline: true },
        { name: 'Geopend door', value: `<@${ticket.openerId}>`, inline: true },
        { name: 'Ticket', value: `#${String(ticket.ticketNumber).padStart(4, '0')}`, inline: true },
        { name: 'Reden', value: reason || 'Geen reden opgegeven' },
      ],
    })
    .setDescription('Dit kanaal is vergrendeld. Een teamlid met de juiste rechten kan het hieronder definitief verwijderen.');

  await channel.send({ embeds: [closedEmbed], components: [ticketDeleteRow()] }).catch(() => {});

  const targetChannelId = config.transcriptChannelId || config.logChannelId;
  if (targetChannelId) {
    try {
      const logChannel = await channel.client.channels.fetch(targetChannelId);
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          embeds: [closedEmbed],
          files: transcript ? [transcript] : [],
        });
      }
    } catch (err) {
      logger.warn(`Kon transcript niet versturen naar log kanaal: ${err.message}`);
    }
  }

  await logger.auditLog(channel.client, {
    action: 'TICKET_CLOSE',
    discordId: closedBy.id,
    details: `Ticket #${ticket.ticketNumber} (${channel.name}) gesloten. Reden: ${reason || 'geen'}`,
  });
}

/** True if the member can manage tickets (claim/close/add/remove/delete). */
function canManageTickets(interaction) {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    false
  );
}

module.exports = { closeTicketChannel, canManageTickets };
