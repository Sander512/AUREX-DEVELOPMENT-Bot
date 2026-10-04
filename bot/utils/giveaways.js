// bot/utils/giveaways.js
// Shared helpers for the button-based giveaway system (GiveawayBot-style
// 🎉 "Enter" button + live entry counter) — used by the slash commands,
// the button/modal handler, and the scheduler.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const embeds = require('./embeds');
const logger = require('./logger');

const GIVEAWAY_EMOJI = '🎉';
const ENTER_BUTTON_PREFIX = 'giveaway_enter_';

const DURATION_RE = /(\d+)\s*(w|d|h|m|s)/gi;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Parses a compact duration string like "1d", "2h30m", "45s" — or a plain
 * English phrase like "10 minutes" / "2 hours" — into milliseconds.
 * Returns null if nothing valid could be parsed.
 */
function parseDuration(input) {
  if (!input || typeof input !== 'string') return null;

  const normalized = input
    .toLowerCase()
    .replace(/seconden|seconds|second|sec\b/g, 's')
    .replace(/minuten|minuut|minutes|minute|min\b/g, 'm')
    .replace(/uren|uur|hours|hour|hr\b/g, 'h')
    .replace(/dagen|dag|days|day/g, 'd')
    .replace(/weken|week|weeks/g, 'w');

  let total = 0;
  let matched = false;

  for (const match of normalized.matchAll(DURATION_RE)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += amount * UNIT_MS[unit];
  }

  if (!matched || total <= 0) return null;
  return total;
}

/** Random, no-repeat pick of `count` winners from a pool of user IDs. */
function pickWinners(pool, count) {
  const unique = [...new Set(pool)];
  const shuffled = unique.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(0, count));
}

function formatWinners(winnerIds) {
  if (!winnerIds || winnerIds.length === 0) return 'Niemand deed mee — geen winnaar.';
  return winnerIds.map((id) => `<@${id}>`).join(', ');
}

/**
 * Builds the giveaway embed, styled like GiveawayBot: prize as the title,
 * an optional description, then "Ends / Hosted by / Entries / Winners"
 * lines — for both the still-running and the already-ended state.
 */
function buildGiveawayEmbed({ prize, description, winnerCount, hostId, requiredRoleId, endsAt, ended, winners, entryCount }) {
  const ts = Math.floor(endsAt / 1000);
  const lines = [];

  if (description) lines.push(description, '');

  lines.push(ended ? `Ended: <t:${ts}:R> (<t:${ts}:f>)` : `Ends: <t:${ts}:R> (<t:${ts}:f>)`);
  lines.push(`Hosted by: <@${hostId}>`);
  if (requiredRoleId) lines.push(`Vereiste rol: <@&${requiredRoleId}>`);
  lines.push(`Entries: ${entryCount ?? 0}`);
  lines.push(`Winners: ${winnerCount}`);

  if (ended) {
    lines.push('', `Winner(s): ${formatWinners(winners)}`);
  }

  return embeds.custom({
    title: prize,
    description: lines.join('\n'),
    color: ended ? 0x6b7280 : 0x5865f2,
  });
}

/** Builds the 🎉 "Enter" button row shown under the giveaway message. */
function buildGiveawayButtonRow(giveawayId, ended) {
  const button = new ButtonBuilder()
    .setCustomId(`${ENTER_BUTTON_PREFIX}${giveawayId}`)
    .setEmoji(GIVEAWAY_EMOJI)
    .setStyle(ButtonStyle.Primary)
    .setLabel(ended ? 'Giveaway afgelopen' : 'Meedoen')
    .setDisabled(Boolean(ended));

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Draws winners for a giveaway: applies the required-role filter (if any)
 * to its stored entries, picks winners, edits the embed + button to their
 * "ended" state, announces in-channel, and persists the result via the
 * API. Shared by /giveaway-end and the auto-end scheduler so both behave
 * identically.
 */
async function drawGiveaway({ client, giveaway, api }) {
  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel) {
    await api.cancelGiveaway(giveaway.id).catch(() => {});
    return { cancelled: true, reason: 'Kanaal niet gevonden' };
  }

  const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (!message) {
    await api.cancelGiveaway(giveaway.id).catch(() => {});
    return { cancelled: true, reason: 'Bericht niet gevonden' };
  }

  let pool = giveaway.entries || [];

  if (giveaway.requiredRoleId) {
    const guild = channel.guild;
    const members = pool.length ? await guild.members.fetch({ user: pool }).catch(() => new Map()) : new Map();
    pool = pool.filter((id) => members.get(id)?.roles.cache.has(giveaway.requiredRoleId));
  }

  const winners = pickWinners(pool, giveaway.winnerCount);

  const endedEmbed = buildGiveawayEmbed({
    prize: giveaway.prize,
    description: giveaway.description,
    winnerCount: giveaway.winnerCount,
    hostId: giveaway.hostId,
    requiredRoleId: giveaway.requiredRoleId,
    endsAt: giveaway.endsAt,
    ended: true,
    winners,
    entryCount: giveaway.entryCount ?? (giveaway.entries || []).length,
  });

  await message.edit({ embeds: [endedEmbed], components: [buildGiveawayButtonRow(giveaway.id, true)] }).catch(() => {});

  await channel
    .send({
      content: winners.length ? winners.map((id) => `<@${id}>`).join(', ') : undefined,
      embeds: [
        embeds.custom({
          title: winners.length ? `🎉 Gefeliciteerd!` : 'Giveaway geëindigd',
          description: winners.length
            ? `${formatWinners(winners)} heeft/hebben **${giveaway.prize}** gewonnen!`
            : `Niemand heeft meegedaan aan de giveaway voor **${giveaway.prize}**.`,
          color: winners.length ? 0x10b981 : 0x6b7280,
        }),
      ],
    })
    .catch((err) => logger.warn(`Kon giveaway-aankondiging niet versturen: ${err.message}`));

  await api.endGiveaway(giveaway.id, winners);

  return { cancelled: false, winners };
}

module.exports = {
  GIVEAWAY_EMOJI,
  ENTER_BUTTON_PREFIX,
  parseDuration,
  pickWinners,
  formatWinners,
  buildGiveawayEmbed,
  buildGiveawayButtonRow,
  drawGiveaway,
};
