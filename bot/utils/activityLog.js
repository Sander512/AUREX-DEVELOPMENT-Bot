// bot/utils/activityLog.js
// Activiteiten-log: joins, leaves (met waarschuwing bij jonge accounts) en
// rol-wijzigingen (met waarschuwing bij gevaarlijke rollen).
// Kanaal instellen met: /security activiteit kanaal:#kanaal

const { AuditLogEvent } = require('discord.js');
const config = require('../config');
const embeds = require('./embeds');
const logger = require('./logger');
const security = require('./security');

const DAY = 86400000;

function ts(ms, style) {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function formatAge(ms) {
  const days = Math.floor(ms / DAY);
  if (days >= 1) return `${days} dag${days === 1 ? '' : 'en'}`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} uur`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}

const warnedNoChannel = new Set();

async function send(guild, s, embed, { pingRoleId = null } = {}) {
  const channelId =
    s.activity.channelId || config.roles.activityLogChannelId || s.logChannelId || config.roles.auditLogChannelId;

  if (!channelId) {
    if (!warnedNoChannel.has(guild.id)) {
      warnedNoChannel.add(guild.id);
      logger.warn(
        `Activiteiten-log: geen kanaal ingesteld voor ${guild.name || guild.id}. Zet ACTIVITY_LOG_CHANNEL_ID in .env of gebruik /security activiteit kanaal:#kanaal.`
      );
    }
    return;
  }

  try {
    const channel = await guild.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    await channel.send({
      content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
      embeds: [embed],
      allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] },
    });
  } catch (err) {
    logger.warn(`Activiteiten-log: versturen mislukt: ${err.message}`);
  }
}

async function logJoin(member, removed = false) {
  const s = await security.getSettings(member.guild.id);
  if (!s.enabled || !s.activity.enabled) return;

  // Tijdens een raid staat alles al in de raid-samenvatting; niet elke
  // geweerde joiner apart loggen.
  if (removed && s.runtime.raidUntil > Date.now()) return;

  const user = member.user;
  const ageMs = Date.now() - user.createdTimestamp;
  const young = ageMs < s.activity.warnDays * DAY;

  const fields = [
    { name: 'Account aangemaakt', value: `${ts(user.createdTimestamp, 'F')}\n(${ts(user.createdTimestamp, 'R')})`, inline: true },
    { name: 'Account-leeftijd', value: formatAge(ageMs), inline: true },
    { name: 'ID', value: user.id, inline: true },
  ];

  let title = '📥 Lid gejoind';
  let color = config.colors.success;

  if (user.bot) {
    title = '🤖 Bot toegevoegd';
    color = config.colors.warning;
    const entry = await security.findEntry(member.guild, AuditLogEvent.BotAdd, user.id);
    fields.push({
      name: 'Toegevoegd door',
      value: entry?.executor ? `<@${entry.executor.id}> (${entry.executor.tag})` : 'Onbekend',
    });
  } else if (young) {
    title = '⚠️ Nieuw account gejoind';
    color = config.colors.warning;
    fields.push({
      name: 'Waarschuwing',
      value: `Dit account is jonger dan ${s.activity.warnDays} dagen. Let op voor alts of raiders.`,
    });
  }

  if (removed) fields.push({ name: 'Actie', value: '🛡️ Automatisch geweerd door de beveiliging' });

  const shouldPing = s.activity.ping && (young || user.bot) && config.roles.staffRoleId;

  await send(
    member.guild,
    s,
    embeds.custom({
      title,
      description: `<@${user.id}> (${user.tag})`,
      color,
      thumbnail: user.displayAvatarURL(),
      fields,
    }),
    { pingRoleId: shouldPing ? config.roles.staffRoleId : null }
  );
}

async function logLeave(member) {
  const s = await security.getSettings(member.guild.id);
  if (!s.enabled || !s.activity.enabled) return;

  const user = member.user;
  const roles = member.roles?.cache
    ? member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`)
    : [];

  await send(
    member.guild,
    s,
    embeds.custom({
      title: user.bot ? '🤖 Bot verwijderd' : '📤 Lid vertrokken',
      description: `<@${user.id}> (${user.tag})`,
      color: config.colors.error,
      thumbnail: user.displayAvatarURL(),
      fields: [
        {
          name: 'Gejoind',
          value: member.joinedTimestamp ? `${ts(member.joinedTimestamp, 'R')}` : 'Onbekend',
          inline: true,
        },
        { name: 'ID', value: user.id, inline: true },
        { name: 'Rollen', value: roles.length ? roles.join(' ').slice(0, 1000) : 'Geen' },
      ],
    })
  );
}

async function logRoleChange(oldMember, newMember) {
  const guild = newMember.guild;
  const s = await security.getSettings(guild.id);
  if (!s.enabled || !s.activity.enabled || !s.activity.roles) return;

  const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
  if (!added.size && !removedRoles.size) return;

  const ids = new Set([...added.keys(), ...removedRoles.keys()]);
  const entry = await security.findEntry(
    guild,
    AuditLogEvent.MemberRoleUpdate,
    newMember.id,
    (e) => e.changes?.some((c) => (c.key === '$add' || c.key === '$remove') && c.new?.some((r) => ids.has(r.id)))
  );
  const executor = entry?.executor || null;

  // Rol-acties van de bot zelf (bijv. verificatie) niet loggen.
  if (executor?.id === guild.client.user.id) return;

  const dangerous = added.filter((r) => r.permissions.any(security.DANGEROUS_PERMS));

  const fields = [
    { name: 'Lid', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
    { name: 'Gedaan door', value: executor ? `<@${executor.id}> (${executor.tag})` : 'Onbekend', inline: true },
  ];
  if (added.size) fields.push({ name: '➕ Rol(len) gegeven', value: added.map((r) => `<@&${r.id}>`).join(' ') });
  if (removedRoles.size) fields.push({ name: '➖ Rol(len) weggehaald', value: removedRoles.map((r) => `<@&${r.id}>`).join(' ') });

  let title = '🏷️ Rollen aangepast';
  let color = config.colors.info;

  if (dangerous.size) {
    title = '🚨 Gevaarlijke rol gegeven';
    color = config.colors.error;
    let warning = `De rol ${dangerous.map((r) => `**${r.name}**`).join(', ')} heeft beheerrechten (bijv. Administrator, rollen/kanalen beheren, kick/ban).`;

    const executorMember = executor ? await guild.members.fetch(executor.id).catch(() => null) : null;
    if (!executorMember || !security.isTrusted(executorMember, s)) {
      warning += '\n⚠️ Dit is gedaan door iemand die geen staff, admin of whitelist is, of door een onbekende uitvoerder.';
    }
    fields.push({ name: 'Waarschuwing', value: warning });
  }

  await send(guild, s, embeds.custom({ title, color, thumbnail: newMember.user.displayAvatarURL(), fields }));
}

function init(client) {
  client.on('guildMemberRemove', (member) =>
    logLeave(member).catch((err) => logger.error('Activiteiten-log (leave) fout:', err))
  );

  client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (oldMember.partial) return; // zonder oude staat valt niet te zien wat er veranderd is
    logRoleChange(oldMember, newMember).catch((err) => logger.error('Activiteiten-log (rollen) fout:', err));
  });
}

module.exports = { init, logJoin };
