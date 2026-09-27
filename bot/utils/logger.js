// bot/utils/logger.js
// Simple structured logger + Discord audit-log channel poster.

const config = require('../config');
const embeds = require('./embeds');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function info(msg, ...args) {
  console.log(`[${timestamp()}] [INFO] ${msg}`, ...args);
}

function warn(msg, ...args) {
  console.warn(`[${timestamp()}] [WARN] ${msg}`, ...args);
}

function error(msg, ...args) {
  console.error(`[${timestamp()}] [ERROR] ${msg}`, ...args);
}

/**
 * Send an audit embed to the configured audit log channel, if set.
 * @param {import('discord.js').Client} client
 * @param {{action:string, discordId?:string, details?:string}} entry
 */
async function auditLog(client, entry) {
  info(`AUDIT: ${entry.action} | discord=${entry.discordId || 'N/A'} | ${entry.details || ''}`);

  if (!config.roles.auditLogChannelId) return;

  try {
    const channel = await client.channels.fetch(config.roles.auditLogChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embeds.audit(entry)] });
    }
  } catch (err) {
    warn(`Kon geen audit log versturen naar channel: ${err.message}`);
  }
}

module.exports = { info, warn, error, auditLog };
