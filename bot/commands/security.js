// bot/commands/security.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const security = require('../utils/security');

const ACTIONS = [
  { name: 'Kick', value: 'kick' },
  { name: 'Ban', value: 'ban' },
  { name: 'Timeout (24 uur)', value: 'timeout' },
];

const onOff = (v) => (v ? '🟢 aan' : '🔴 uit');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('security')
    .setDescription('[Management] Beheer de beveiliging (anti-raid, anti-spam, anti-nuke)')
    .addSubcommand((sc) => sc.setName('status').setDescription('Toon alle beveiligingsinstellingen'))
    .addSubcommand((sc) => sc.setName('aan').setDescription('Zet de volledige beveiliging aan'))
    .addSubcommand((sc) => sc.setName('uit').setDescription('Zet de volledige beveiliging uit'))
    .addSubcommand((sc) =>
      sc
        .setName('lockdown')
        .setDescription('Zet de raid-modus handmatig aan of uit')
        .addBooleanOption((o) => o.setName('aan').setDescription('Lockdown aan (true) of uit (false)').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('raid')
        .setDescription('Stel de raid-detectie in')
        .addBooleanOption((o) => o.setName('aan').setDescription('Raid-detectie aan/uit'))
        .addIntegerOption((o) => o.setName('joins').setDescription('Aantal joins dat een raid triggert').setMinValue(2).setMaxValue(50))
        .addIntegerOption((o) => o.setName('seconden').setDescription('Binnen hoeveel seconden').setMinValue(3).setMaxValue(120))
        .addStringOption((o) => o.setName('actie').setDescription('Wat er met nieuwe leden gebeurt tijdens een raid').addChoices(...ACTIONS))
        .addIntegerOption((o) => o.setName('minuten').setDescription('Hoe lang de raid-modus blijft staan').setMinValue(1).setMaxValue(240))
    )
    .addSubcommand((sc) =>
      sc
        .setName('accountleeftijd')
        .setDescription('Weer te nieuwe Discord-accounts')
        .addBooleanOption((o) => o.setName('aan').setDescription('Filter aan/uit'))
        .addIntegerOption((o) => o.setName('dagen').setDescription('Minimale leeftijd van het account in dagen').setMinValue(1).setMaxValue(90))
        .addStringOption((o) => o.setName('actie').setDescription('Wat er met te nieuwe accounts gebeurt').addChoices(...ACTIONS))
    )
    .addSubcommand((sc) =>
      sc
        .setName('spam')
        .setDescription('Stel anti-spam in')
        .addBooleanOption((o) => o.setName('aan').setDescription('Anti-spam aan/uit'))
        .addIntegerOption((o) => o.setName('berichten').setDescription('Aantal berichten dat als flood telt').setMinValue(3).setMaxValue(30))
        .addIntegerOption((o) => o.setName('seconden').setDescription('Binnen hoeveel seconden').setMinValue(2).setMaxValue(30))
        .addIntegerOption((o) => o.setName('mentions').setDescription('Aantal mentions in 1 bericht dat als spam telt').setMinValue(3).setMaxValue(30))
        .addBooleanOption((o) => o.setName('invites').setDescription('Invite-links verwijderen en bestraffen'))
        .addIntegerOption((o) => o.setName('timeout').setDescription('Timeout in minuten').setMinValue(1).setMaxValue(1440))
    )
    .addSubcommand((sc) =>
      sc
        .setName('antinuke')
        .setDescription('Stel anti-nuke in (massaal verwijderen/bannen)')
        .addBooleanOption((o) => o.setName('aan').setDescription('Anti-nuke aan/uit'))
        .addIntegerOption((o) => o.setName('kanalen').setDescription('Max. kanalen verwijderen binnen het tijdvenster').setMinValue(1).setMaxValue(20))
        .addIntegerOption((o) => o.setName('rollen').setDescription('Max. rollen verwijderen binnen het tijdvenster').setMinValue(1).setMaxValue(20))
        .addIntegerOption((o) => o.setName('bans').setDescription('Max. bans binnen het tijdvenster').setMinValue(2).setMaxValue(30))
        .addIntegerOption((o) => o.setName('seconden').setDescription('Tijdvenster in seconden').setMinValue(5).setMaxValue(300))
    )
    .addSubcommand((sc) =>
      sc
        .setName('whitelist-add')
        .setDescription('Vertrouw een gebruiker (wordt nooit door de beveiliging bestraft)')
        .addUserOption((o) => o.setName('gebruiker').setDescription('De gebruiker').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('whitelist-remove')
        .setDescription('Haal een gebruiker van de whitelist')
        .addUserOption((o) => o.setName('gebruiker').setDescription('De gebruiker').setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('activiteit')
        .setDescription('Log joins, leaves, jonge accounts en rol-wijzigingen in een kanaal')
        .addChannelOption((o) => o.setName('kanaal').setDescription('Tekstkanaal voor de activiteiten-log'))
        .addBooleanOption((o) => o.setName('aan').setDescription('Activiteiten-log aan/uit'))
        .addIntegerOption((o) => o.setName('dagen').setDescription('Waarschuw als een account jonger is dan dit aantal dagen').setMinValue(1).setMaxValue(365))
        .addBooleanOption((o) => o.setName('rollen').setDescription('Ook rol-wijzigingen loggen'))
        .addBooleanOption((o) => o.setName('ping').setDescription('Staff-rol pingen bij een jong account of toegevoegde bot'))
    )
    .addSubcommand((sc) =>
      sc
        .setName('logkanaal')
        .setDescription('Kanaal waar beveiligingsmeldingen naartoe gaan')
        .addChannelOption((o) => o.setName('kanaal').setDescription('Tekstkanaal').setRequired(true))
    ),

  async execute(interaction, { client }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const s = await security.getSettings(guild.id);
    const sub = interaction.options.getSubcommand();
    const o = interaction.options;

    // Zet alleen waarden die daadwerkelijk zijn meegegeven.
    const apply = (target, map) => {
      for (const [field, optName, type] of map) {
        const value =
          type === 'bool' ? o.getBoolean(optName) : type === 'int' ? o.getInteger(optName) : o.getString(optName);
        if (value !== null && value !== undefined) target[field] = value;
      }
    };

    let message = null;

    switch (sub) {
      case 'status': {
        const raidActive = s.runtime.raidUntil > Date.now();
        await interaction.editReply({
          embeds: [
            embeds
              .info('Beveiliging', `Totaal: ${onOff(s.enabled)}${raidActive ? '\n🚨 **Raid-modus is nu actief**' : ''}`)
              .addFields(
                {
                  name: 'Anti-raid',
                  value: `${onOff(s.raid.enabled)}\n${s.raid.joins} joins / ${s.raid.seconds}s → ${s.raid.action}\nLockdown: ${s.raid.lockdownMinutes} min`,
                  inline: true,
                },
                {
                  name: 'Account-leeftijd',
                  value: `${onOff(s.accountAge.enabled)}\nMin. ${s.accountAge.minDays} dagen → ${s.accountAge.action}`,
                  inline: true,
                },
                {
                  name: 'Anti-spam',
                  value: `${onOff(s.spam.enabled)}\n${s.spam.messages} berichten / ${s.spam.seconds}s\n${s.spam.mentions} mentions\nInvites: ${onOff(s.spam.invites)}\nTimeout: ${s.spam.timeoutMinutes} min`,
                  inline: true,
                },
                {
                  name: 'Anti-nuke',
                  value: `${onOff(s.nuke.enabled)}\n${s.nuke.channels} kanalen / ${s.nuke.roles} rollen / ${s.nuke.bans} bans\nin ${s.nuke.seconds}s`,
                  inline: true,
                },
                {
                  name: 'Activiteiten-log',
                  value: `${onOff(s.activity.enabled)}\nKanaal: ${s.activity.channelId ? `<#${s.activity.channelId}>` : 'niet ingesteld'}\nWaarschuwing < ${s.activity.warnDays} dagen\nRollen: ${onOff(s.activity.roles)}\nStaff-ping: ${onOff(s.activity.ping)}`,
                  inline: true,
                },
                {
                  name: 'Whitelist',
                  value: s.whitelist.length ? s.whitelist.map((id) => `<@${id}>`).join(', ') : 'Leeg',
                },
                { name: 'Logkanaal', value: s.logChannelId ? `<#${s.logChannelId}>` : 'Audit-log kanaal uit .env' }
              ),
          ],
        });
        return;
      }

      case 'aan':
      case 'uit':
        s.enabled = sub === 'aan';
        message = `Beveiliging staat nu **${sub === 'aan' ? 'aan' : 'uit'}**.`;
        break;

      case 'lockdown': {
        const on = o.getBoolean('aan', true);
        const active = s.runtime.raidUntil > Date.now();
        if (on && !active) {
          await security.startRaid(guild, s, [], { manual: true });
          message = `Lockdown is aan voor ${s.raid.lockdownMinutes} minuten.`;
        } else if (!on && active) {
          await security.endRaid(guild, s);
          message = 'Lockdown is uitgezet.';
        } else {
          message = on ? 'Lockdown stond al aan.' : 'Er was geen lockdown actief.';
        }
        await interaction.editReply({ embeds: [embeds.success('Lockdown', message)] });
        await logger.auditLog(client, {
          action: 'SECURITY LOCKDOWN',
          discordId: interaction.user.id,
          details: on ? 'Aangezet' : 'Uitgezet',
        });
        return;
      }

      case 'raid':
        apply(s.raid, [
          ['enabled', 'aan', 'bool'],
          ['joins', 'joins', 'int'],
          ['seconds', 'seconden', 'int'],
          ['action', 'actie', 'str'],
          ['lockdownMinutes', 'minuten', 'int'],
        ]);
        message = `Anti-raid: ${onOff(s.raid.enabled)} — ${s.raid.joins} joins in ${s.raid.seconds}s → ${s.raid.action}, lockdown ${s.raid.lockdownMinutes} min.`;
        break;

      case 'accountleeftijd':
        apply(s.accountAge, [
          ['enabled', 'aan', 'bool'],
          ['minDays', 'dagen', 'int'],
          ['action', 'actie', 'str'],
        ]);
        message = `Account-leeftijd filter: ${onOff(s.accountAge.enabled)} — minimaal ${s.accountAge.minDays} dagen → ${s.accountAge.action}.`;
        break;

      case 'spam':
        apply(s.spam, [
          ['enabled', 'aan', 'bool'],
          ['messages', 'berichten', 'int'],
          ['seconds', 'seconden', 'int'],
          ['mentions', 'mentions', 'int'],
          ['invites', 'invites', 'bool'],
          ['timeoutMinutes', 'timeout', 'int'],
        ]);
        message = `Anti-spam: ${onOff(s.spam.enabled)} — ${s.spam.messages} berichten in ${s.spam.seconds}s, ${s.spam.mentions} mentions, invites ${onOff(s.spam.invites)}, timeout ${s.spam.timeoutMinutes} min.`;
        break;

      case 'antinuke':
        apply(s.nuke, [
          ['enabled', 'aan', 'bool'],
          ['channels', 'kanalen', 'int'],
          ['roles', 'rollen', 'int'],
          ['bans', 'bans', 'int'],
          ['seconds', 'seconden', 'int'],
        ]);
        message = `Anti-nuke: ${onOff(s.nuke.enabled)} — ${s.nuke.channels} kanalen / ${s.nuke.roles} rollen / ${s.nuke.bans} bans in ${s.nuke.seconds}s.`;
        break;

      case 'whitelist-add': {
        const user = o.getUser('gebruiker', true);
        if (!s.whitelist.includes(user.id)) s.whitelist.push(user.id);
        message = `<@${user.id}> staat op de whitelist.`;
        break;
      }

      case 'whitelist-remove': {
        const user = o.getUser('gebruiker', true);
        s.whitelist = s.whitelist.filter((id) => id !== user.id);
        message = `<@${user.id}> is van de whitelist gehaald.`;
        break;
      }

      case 'activiteit': {
        const channel = o.getChannel('kanaal');
        if (channel) {
          if (!channel.isTextBased()) {
            await interaction.editReply({ embeds: [embeds.error('Ongeldig kanaal', 'Kies een tekstkanaal.')] });
            return;
          }
          s.activity.channelId = channel.id;
        }
        apply(s.activity, [
          ['enabled', 'aan', 'bool'],
          ['warnDays', 'dagen', 'int'],
          ['roles', 'rollen', 'bool'],
          ['ping', 'ping', 'bool'],
        ]);
        message = `Activiteiten-log: ${onOff(s.activity.enabled)} — kanaal ${s.activity.channelId ? `<#${s.activity.channelId}>` : 'nog niet ingesteld (valt terug op het logkanaal)'}, waarschuwing onder ${s.activity.warnDays} dagen, rollen ${onOff(s.activity.roles)}, staff-ping ${onOff(s.activity.ping)}.`;
        break;
      }

      case 'logkanaal': {
        const channel = o.getChannel('kanaal', true);
        if (!channel.isTextBased()) {
          await interaction.editReply({ embeds: [embeds.error('Ongeldig kanaal', 'Kies een tekstkanaal.')] });
          return;
        }
        s.logChannelId = channel.id;
        message = `Beveiligingsmeldingen gaan nu naar <#${channel.id}>.`;
        break;
      }

      default:
        return;
    }

    await security.saveSettings(guild.id, s);
    await interaction.editReply({ embeds: [embeds.success('Beveiliging bijgewerkt', message)] });

    await logger.auditLog(client, {
      action: `SECURITY ${sub.toUpperCase()}`,
      discordId: interaction.user.id,
      details: message,
    });
  },
};
