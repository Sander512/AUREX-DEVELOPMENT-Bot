// bot/utils/tickets.js
// Shared helpers for the ticket panel system — kept separate from the
// commands/handlers so both can reuse the exact same logic.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');

/** Turn a stored hex string ("1e3a8a" or "#1e3a8a") into a Discord color int. */
function hexToInt(hex, fallback = 0x1e3a8a) {
  if (!hex) return fallback;
  const clean = hex.replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Fill in {number}, {user}, {type}, {server} placeholders in a
 * user-configured template string (channel name / welcome message).
 */
function formatTemplate(template, { number, user, type } = {}) {
  return String(template || '')
    .replaceAll('{number}', number !== undefined ? String(number).padStart(4, '0') : '')
    .replaceAll('{user}', user || '')
    .replaceAll('{type}', type || '');
}

/** Discord channel names: lowercase, a-z0-9-, max 100 chars, never empty. */
function sanitizeChannelName(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return (cleaned || 'ticket').slice(0, 100);
}

/**
 * Builds the claim/close button row. Either button can be turned off
 * entirely per ticket-type (claimEnabled / closeEnabled) — e.g. a type
 * where tickets should never be manually closed by the opener. Returns
 * null when both buttons are disabled, since Discord doesn't allow an
 * empty action row.
 */
function ticketControlRow({ claimed = false, closed = false, claimEnabled = true, closeEnabled = true } = {}) {
  const buttons = [];

  if (claimEnabled) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel(claimed ? 'Geclaimd' : 'Claim')
        .setEmoji('🙋')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(claimed || closed)
    );
  }

  if (closeEnabled) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Sluiten')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(closed)
    );
  }

  if (buttons.length === 0) return null;
  return new ActionRowBuilder().addComponents(buttons);
}

function ticketDeleteRow() {
  const deleteBtn = new ButtonBuilder()
    .setCustomId('ticket_delete')
    .setLabel('Verwijder kanaal')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(deleteBtn);
}

/**
 * Build a plain-text transcript of a channel by paging through its
 * message history, and return it as a ready-to-send AttachmentBuilder.
 */
async function generateTranscript(channel, { ticketNumber, limit = 500 } = {}) {
  const collected = [];
  let before;

  while (collected.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    collected.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) break;
  }

  collected.reverse(); // oldest first

  const lines = collected.map((m) => {
    const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const author = `${m.author.tag} (${m.author.id})`;
    const content = m.content || (m.embeds.length ? '[embed]' : '');
    const attachments = m.attachments.map((a) => a.url).join(' ');
    return `[${time}] ${author}: ${content}${attachments ? ` ${attachments}` : ''}`;
  });

  const header = [
    `Transcript — ticket #${String(ticketNumber ?? '?').padStart(4, '0')}`,
    `Kanaal: #${channel.name} (${channel.id})`,
    `Gegenereerd op: ${new Date().toISOString()}`,
    '='.repeat(60),
    '',
  ];

  const buffer = Buffer.from([...header, ...lines].join('\n'), 'utf-8');
  return new AttachmentBuilder(buffer, { name: `transcript-ticket-${ticketNumber ?? channel.id}.txt` });
}

module.exports = {
  hexToInt,
  formatTemplate,
  sanitizeChannelName,
  ticketControlRow,
  ticketDeleteRow,
  generateTranscript,
};
