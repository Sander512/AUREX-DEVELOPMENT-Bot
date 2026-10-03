// bot/utils/security.js
// Beveiligingsmodule: anti-raid, account-leeftijd filter, anti-spam en anti-nuke.
//
// Instellingen staan per server in de database (bot_settings, key
// "security:<guildId>") en worden beheerd met /security.

const {
  PermissionFlagsBits,
  AuditLogEvent,
  GuildVerificationLevel,
} = require('discord.js');
const config = require('../config');
const logger = require('./logger');
const embeds = require('./embeds');
const { getSetting, setSetting } = require('../../api/database');

const DEFAULTS = {
  enabled: true,
  logChannelId: null,
  whitelist: [],

  // Veel joins in korte tijd => raid-modus.
  raid: { enabled: true, joins: 5, seconds: 10, action: 'kick', lockdownMinutes: 10 },

  // Te nieuwe Discord-accounts weren (standaard uit, zodat echte nieuwe
  // gebruikers niet per ongeluk buiten de deur blijven).
  accountAge: { enabled: false, minDays: 3, action: 'kick' },

  // Flood, mention-spam en invite-links.
  spam: { enabled: true, messages: 7, seconds: 5, mentions: 6, invites: true, timeoutMinutes: 10 },

  // Iemand die razendsnel kanalen/rollen verwijdert of mensen bant.
  nuke: { enabled: true, channels: 3, roles: 3, bans: 5, seconds: 30 },

  // Activiteiten-log: joins, leaves, jonge accounts en rol-wijzigingen.
  activity: { enabled: true, channelId: null, warnDays: 7, roles: true, ping: true },

  // Runtime-status van een lopende raid (overleeft een herstart).
  runtime: { raidUntil: 0, prevLevel: null, actioned: 0 },
};

const DANGEROUS_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
];

// ---------------------------------------------------------------------
// Instellingen
// ---------------------------------------------------------------------

const cache = new Map(); // guildId -> Promise<settings>

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function merge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(extra || {})) {
    if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], extra[key]);
    } else {
      out[key] = extra[key];
    }
  }
  return out;
}

function getSettings(guildId) {
  if (!cache.has(guildId)) {
    const promise = (async () => {
      let stored = null;
      try {
        const raw = await getSetting(`security:${guildId}`);
        if (raw) stored = JSON.parse(raw);
      } catch (err) {
        logger.warn(`Security: kon instellingen van ${guildId} niet laden, standaardwaarden gebruikt: ${err.message}`);
      }
      return merge(clone(DEFAULTS), stored || {});
    })();
    cache.set(guildId, promise);
  }
  return cache.get(guildId);
}

async function saveSettings(guildId, settings) {
  await setSetting(`security:${guildId}`, JSON.stringify(settings));
}

// ---------------------------------------------------------------------
// Hulpfuncties
// ---------------------------------------------------------------------

const joinTracker = new Map(); // guildId -> [{ id, ts }]
const spamTracker = new Map(); // guildId:userId -> [{ ts, id, channelId }]
const nukeTracker = new Map(); // guildId:executorId:type -> [ts]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTrusted(member, s) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (s.whitelist.includes(member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const { staffRoleId, managementRoleId } = config.roles;
  if (staffRoleId && member.roles.cache.has(staffRoleId)) return true;
  if (managementRoleId && member.roles.cache.has(managementRoleId)) return true;
  return false;
}

async function notify(guild, s, embed) {
  const channelId = s.logChannelId || config.roles.auditLogChannelId;
  if (!channelId) return;
  try {
    const channel = await guild.client.channels.fetch(channelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.warn(`Security: kon melding niet versturen: ${err.message}`);
  }
}

// Past de gekozen actie toe op een nieuw lid. Geeft true terug als het lid
// van de server is verwijderd (kick/ban).
async function punishJoin(member, action, reason) {
  try {
    if (action === 'ban') {
      await member.ban({ reason });
      return true;
    }
    if (action === 'timeout') {
      await member.timeout(24 * 60 * 60 * 1000, reason);
      return false;
    }
    await member.kick(reason);
    return true;
  } catch (err) {
    logger.warn(`Security: ${action} van ${member.id} mislukt: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------
// Anti-raid
// ---------------------------------------------------------------------

async function startRaid(guild, s, tracked = [], { manual = false } = {}) {
  // Synchroon zetten voor de eerste await, zodat gelijktijdige joins niet
  // allemaal een eigen raid starten.
  s.runtime.raidUntil = Date.now() + s.raid.lockdownMinutes * 60 * 1000;
  s.runtime.actioned = 0;

  if (guild.verificationLevel < GuildVerificationLevel.VeryHigh) {
    s.runtime.prevLevel = guild.verificationLevel;
    await guild
      .setVerificationLevel(GuildVerificationLevel.VeryHigh, 'Anti-raid: raid-modus actief')
      .catch((err) => logger.warn(`Security: verificatieniveau verhogen mislukt: ${err.message}`));
  }

  await saveSettings(guild.id, s).catch(() => {});

  await notify(
    guild,
    s,
    embeds.warning(
      manual ? 'Lockdown ingeschakeld' : 'RAID gedetecteerd',
      `${manual ? 'Handmatige lockdown' : `**${tracked.length}** joins in ${s.raid.seconds} seconden`}.\n` +
        `Nieuwe leden krijgen de komende **${s.raid.lockdownMinutes} min** automatisch: **${s.raid.action}**.\n` +
        'Het verificatieniveau van de server is verhoogd.'
    )
  );

  const removed = new Set();
  for (const { id } of tracked) {
    const member = guild.members.cache.get(id);
    if (!member || isTrusted(member, s)) continue;
    if (await punishJoin(member, s.raid.action, 'Anti-raid: massale join gedetecteerd')) removed.add(id);
    s.runtime.actioned += 1;
  }
  return removed;
}

async function endRaid(guild, s) {
  const count = s.runtime.actioned;

  if (s.runtime.prevLevel !== null) {
    await guild
      .setVerificationLevel(s.runtime.prevLevel, 'Anti-raid: raid-modus afgelopen')
      .catch((err) => logger.warn(`Security: verificatieniveau herstellen mislukt: ${err.message}`));
  }

  s.runtime = { raidUntil: 0, prevLevel: null, actioned: 0 };
  await saveSettings(guild.id, s).catch(() => {});

  await notify(
    guild,
    s,
    embeds.success('Raid-modus afgelopen', `De server is weer normaal. Er zijn **${count}** nieuwe leden geweerd.`)
  );
}

// Geeft true terug als het lid is verwijderd (dan hoeft de welkomstflow niet).
async function handleJoin(member) {
  if (member.user.bot) return false;

  const s = await getSettings(member.guild.id);
  if (!s.enabled || isTrusted(member, s)) return false;

  // 1. Raid loopt al: iedereen die nu joint wordt direct geweerd.
  if (s.runtime.raidUntil > Date.now()) {
    s.runtime.actioned += 1;
    return punishJoin(member, s.raid.action, 'Anti-raid: server staat in raid-modus');
  }

  // 2. Joins tellen.
  if (s.raid.enabled) {
    const now = Date.now();
    const list = (joinTracker.get(member.guild.id) || []).filter((j) => now - j.ts < s.raid.seconds * 1000);
    list.push({ id: member.id, ts: now });
    joinTracker.set(member.guild.id, list);

    if (list.length >= s.raid.joins) {
      joinTracker.delete(member.guild.id);
      const removed = await startRaid(member.guild, s, list);
      return removed.has(member.id);
    }
  }

  // 3. Account te nieuw?
  if (s.accountAge.enabled) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (ageDays < s.accountAge.minDays) {
      logger.info(`Security: ${member.user.tag} geweerd, account is ${ageDays.toFixed(1)} dagen oud.`);
      return punishJoin(
        member,
        s.accountAge.action,
        `Account is jonger dan ${s.accountAge.minDays} dagen`
      );
    }
  }

  return false;
}

// ---------------------------------------------------------------------
// Anti-spam
// ---------------------------------------------------------------------

const INVITE_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;

async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;

  const s = await getSettings(message.guild.id);
  if (!s.enabled || !s.spam.enabled) return;

  const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isTrusted(member, s)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const list = (spamTracker.get(key) || []).filter((m) => now - m.ts < s.spam.seconds * 1000);
  list.push({ ts: now, id: message.id, channelId: message.channelId });
  spamTracker.set(key, list);

  let reason = null;
  if (list.length >= s.spam.messages) {
    reason = `Berichten-flood (${list.length} in ${s.spam.seconds}s)`;
  } else if (message.mentions.users.size + message.mentions.roles.size >= s.spam.mentions) {
    reason = 'Mention-spam';
  } else if (s.spam.invites && message.content && INVITE_REGEX.test(message.content)) {
    reason = 'Invite-link geplaatst';
  }

  if (!reason) return;

  spamTracker.delete(key);

  // Opruimen: de berichten van de afgelopen seconden verwijderen.
  for (const m of list) {
    const channel = message.guild.channels.cache.get(m.channelId);
    await channel?.messages.delete(m.id).catch(() => {});
  }

  let timedOut = false;
  if (member.moderatable) {
    timedOut = await member
      .timeout(s.spam.timeoutMinutes * 60 * 1000, `Anti-spam: ${reason}`)
      .then(() => true)
      .catch(() => false);
  }

  await notify(
    message.guild,
    s,
    embeds.warning(
      'Anti-spam',
      `<@${member.id}> (${message.author.tag})\nReden: **${reason}**\n` +
        (timedOut ? `Timeout: ${s.spam.timeoutMinutes} min` : 'Timeout niet mogelijk (rol hoger dan de bot?)')
    )
  );
}

// ---------------------------------------------------------------------
// Anti-nuke
// ---------------------------------------------------------------------

async function findEntry(guild, event, targetId, matcher = () => true) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const logs = await guild.fetchAuditLogs({ type: event, limit: 10 }).catch(() => null);
    const entry = logs?.entries.find(
      (e) => e.targetId === targetId && Date.now() - e.createdTimestamp < 15000 && matcher(e)
    );
    if (entry) return entry;
    await sleep(1000);
  }
  return null;
}

async function findExecutor(guild, event, targetId) {
  const entry = await findEntry(guild, event, targetId);
  return entry ? entry.executor : null;
}

async function punishExecutor(guild, executor, s, why) {
  const member = await guild.members.fetch(executor.id).catch(() => null);
  let result;

  if (!member) {
    result = 'Uitvoerder zit niet meer op de server.';
  } else if (executor.bot) {
    result = await member
      .kick(`Anti-nuke: ${why}`)
      .then(() => 'Bot is gekickt.')
      .catch((err) => `Bot kicken mislukt: ${err.message}`);
  } else {
    const roles = member.roles.cache.filter(
      (r) => r.id !== guild.id && !r.managed && r.editable && r.permissions.any(DANGEROUS_PERMS)
    );
    if (roles.size === 0) {
      result =
        'Geen rollen om af te pakken. Staat de rol van de bot boven de rollen van deze persoon? Zet de bot-rol zo hoog mogelijk.';
    } else {
      result = await member.roles
        .remove(roles, `Anti-nuke: ${why}`)
        .then(() => `Gevaarlijke rollen afgepakt: ${roles.map((r) => r.name).join(', ')}`)
        .catch((err) => `Rollen afpakken mislukt: ${err.message}`);
    }
  }

  await notify(
    guild,
    s,
    embeds.error('ANTI-NUKE ingegrepen', `<@${executor.id}> (${executor.tag})\nReden: **${why}**\n${result}`)
  );
}

async function recordNuke(guild, type, auditEvent, targetId) {
  const s = await getSettings(guild.id);
  if (!s.enabled || !s.nuke.enabled) return;

  const executor = await findExecutor(guild, auditEvent, targetId);
  if (!executor) return;
  if (executor.id === guild.client.user.id || executor.id === guild.ownerId) return;
  if (s.whitelist.includes(executor.id)) return;

  const key = `${guild.id}:${executor.id}:${type}`;
  const now = Date.now();
  const list = (nukeTracker.get(key) || []).filter((ts) => now - ts < s.nuke.seconds * 1000);
  list.push(now);
  nukeTracker.set(key, list);

  const limit = s.nuke[type];
  if (list.length >= limit) {
    nukeTracker.delete(key);
    const label = { channels: 'kanalen verwijderd', roles: 'rollen verwijderd', bans: 'leden gebanned' }[type];
    await punishExecutor(guild, executor, s, `${list.length} ${label} in ${s.nuke.seconds}s`);
  }
}

// ---------------------------------------------------------------------
// Opstarten
// ---------------------------------------------------------------------

function init(client) {
  client.on('messageCreate', (message) =>
    handleMessage(message).catch((err) => logger.error('Security: fout bij anti-spam:', err))
  );

  client.on('channelDelete', (channel) => {
    if (!channel.guild) return;
    recordNuke(channel.guild, 'channels', AuditLogEvent.ChannelDelete, channel.id).catch((err) =>
      logger.error('Security: fout bij anti-nuke (kanaal):', err)
    );
  });

  client.on('roleDelete', (role) => {
    recordNuke(role.guild, 'roles', AuditLogEvent.RoleDelete, role.id).catch((err) =>
      logger.error('Security: fout bij anti-nuke (rol):', err)
    );
  });

  client.on('guildBanAdd', (ban) => {
    recordNuke(ban.guild, 'bans', AuditLogEvent.MemberBanAdd, ban.user.id).catch((err) =>
      logger.error('Security: fout bij anti-nuke (ban):', err)
    );
  });
}

// Aanroepen zodra de bot ready is: laadt instellingen (ook een raid die
// tijdens een herstart nog liep) en beëindigt raid-modus wanneer de tijd om is.
async function start(client) {
  for (const guild of client.guilds.cache.values()) {
    await getSettings(guild.id);
  }

  setInterval(async () => {
    const now = Date.now();

    for (const [guildId, promise] of cache) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const s = await promise;
      if (s.runtime.raidUntil && s.runtime.raidUntil <= now) {
        await endRaid(guild, s).catch((err) => logger.error('Security: raid-modus beëindigen mislukt:', err));
      }
    }

    // Geheugen opschonen.
    for (const [key, list] of spamTracker) {
      if (!list.length || now - list[list.length - 1].ts > 60000) spamTracker.delete(key);
    }
    for (const [key, list] of nukeTracker) {
      if (!list.length || now - list[list.length - 1] > 300000) nukeTracker.delete(key);
    }
    for (const [key, list] of joinTracker) {
      if (!list.length || now - list[list.length - 1].ts > 300000) joinTracker.delete(key);
    }
  }, 30 * 1000);

  logger.info('Security-module actief (anti-raid, anti-spam, anti-nuke).');
}

module.exports = {
  DEFAULTS,
  init,
  start,
  handleJoin,
  getSettings,
  saveSettings,
  startRaid,
  endRaid,
  isTrusted,
  findEntry,
  DANGEROUS_PERMS,
};
