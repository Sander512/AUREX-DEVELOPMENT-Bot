// bot/utils/embeds.js
// Central place for building consistent, branded embeds.

const { EmbedBuilder } = require('discord.js');
const config = require('../config');

function base() {
  return new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: `© ${config.brand.name}` });
}

function success(title, description) {
  return base()
    .setColor(config.colors.success)
    .setTitle(`✅ ${title}`)
    .setDescription(description || null);
}

function error(title, description) {
  return base()
    .setColor(config.colors.error)
    .setTitle(`❌ ${title}`)
    .setDescription(description || null);
}

function info(title, description) {
  return base()
    .setColor(config.colors.info)
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description || null);
}

function warning(title, description) {
  return base()
    .setColor(config.colors.warning)
    .setTitle(`⚠️ ${title}`)
    .setDescription(description || null);
}

function audit({ action, discordId, details }) {
  return base()
    .setColor(config.colors.primary)
    .setTitle(`📝 Audit Log — ${action}`)
    .addFields(
      { name: 'Discord', value: discordId ? `<@${discordId}>` : 'N/A', inline: true },
      { name: 'Details', value: details || 'Geen extra details' }
    );
}

// Fully flexible embed used by the ticket, welcome, verify and rules
// systems, where colors/images/text are all configured at runtime through
// slash commands or the dashboard instead of hardcoded.
function custom({ title, description, color, image, thumbnail, footer, fields }) {
  const embed = base().setColor(color ?? config.colors.primary);

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (image) embed.setImage(image);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (footer) embed.setFooter({ text: footer });
  if (fields?.length) embed.addFields(fields);

  return embed;
}

module.exports = {
  success,
  error,
  info,
  warning,
  audit,
  custom,
};
