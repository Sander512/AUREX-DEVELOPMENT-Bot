// bot/utils/welcome.js
// Shared helpers for the configurable welcome-message system. The config
// itself lives entirely on the dashboard (api/routes/welcome.js) — this
// file just turns that config + a joining member into an actual Discord
// message, and applies the auto-role if one is set.

const { hexToInt } = require('./tickets');
const embeds = require('./embeds');
const logger = require('./logger');

/**
 * Fills in {user} (mention), {username}, {server} and {membercount}
 * placeholders in a configured template string.
 */
function fillWelcomePlaceholders(template, member) {
  return String(template || '')
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{username\}/g, member.user.username)
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{membercount\}/g, String(member.guild.memberCount));
}

/** Builds the { content, embeds } payload for a given member + config. */
function buildWelcomePayload(config, member) {
  const payload = {};

  if (config.content) {
    payload.content = fillWelcomePlaceholders(config.content, member);
  }

  if (config.embedEnabled) {
    const embed = embeds.custom({
      title: config.embedTitle ? fillWelcomePlaceholders(config.embedTitle, member) : undefined,
      description: config.embedDescription ? fillWelcomePlaceholders(config.embedDescription, member) : undefined,
      color: hexToInt(config.embedColor, 0x10b981),
      image: config.embedImage || undefined,
      thumbnail: config.useAvatarThumbnail ? member.user.displayAvatarURL({ size: 256 }) : undefined,
      footer: config.embedFooter || undefined,
    });

    payload.embeds = [embed];
  }

  return payload;
}

/**
 * Handles a single guildMemberAdd: posts the welcome message (if
 * enabled), assigns the auto-role (if set), and sends the DM (if
 * enabled) — every part is independently optional and failures in one
 * never block the others.
 */
async function handleMemberJoin(member, api) {
  let config;
  try {
    ({ config } = await api.getWelcomeConfig(member.guild.id));
  } catch (err) {
    logger.error(`Kon welkomst-config niet ophalen voor ${member.guild.id}: ${err.message}`);
    return;
  }

  if (!config.enabled) return;

  if (config.channelId) {
    const channel = await member.guild.channels.fetch(config.channelId).catch(() => null);
    const botMember = member.guild.members.me;
    if (channel && channel.permissionsFor(botMember)?.has(['ViewChannel', 'SendMessages'])) {
      const payload = buildWelcomePayload(config, member);
      if (payload.content || payload.embeds) {
        await channel.send(payload).catch((err) => logger.warn(`Kon welkomstbericht niet versturen: ${err.message}`));
      }
    } else if (channel === null) {
      logger.warn(`Welkomst-kanaal ${config.channelId} niet gevonden in guild ${member.guild.id}.`);
    }
  }

  if (config.autoRoleId) {
    const role = await member.guild.roles.fetch(config.autoRoleId).catch(() => null);
    if (role) {
      await member.roles.add(role).catch((err) => logger.warn(`Kon auto-rol niet toekennen: ${err.message}`));
    }
  }

  if (config.dmEnabled && config.dmMessage) {
    await member.send({ content: fillWelcomePlaceholders(config.dmMessage, member) }).catch(() => {
      // DMs closed — this is expected often enough that it's not worth logging.
    });
  }
}

module.exports = { fillWelcomePlaceholders, buildWelcomePayload, handleMemberJoin };
