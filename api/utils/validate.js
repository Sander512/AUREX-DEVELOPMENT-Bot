// api/utils/validate.js
// Shared, strict input validation. Never trust data coming from Discord.

const DISCORD_ID_RE = /^[0-9]{15,25}$/;
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;
const TICKET_KEY_RE = /^[a-z0-9_-]{1,32}$/;

function isDiscordId(value) {
  return typeof value === 'string' && DISCORD_ID_RE.test(value);
}

function isPositiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

function normalizeHexColor(value) {
  return value.replace('#', '').toLowerCase();
}

function isTicketKey(value) {
  return typeof value === 'string' && TICKET_KEY_RE.test(value);
}

function slugify(value, maxLength = 32) {
  return (
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'ticket'
  );
}

module.exports = {
  isDiscordId,
  isPositiveInteger,
  isHexColor,
  normalizeHexColor,
  isTicketKey,
  slugify,
};
