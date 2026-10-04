// bot/index.js
// Main Discord bot entry point.

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const config = require('./config');
const permissions = require('./utils/permissions');
const embeds = require('./utils/embeds');
const logger = require('./utils/logger');
const ticketInteractions = require('./handlers/ticketInteractions');
const verifyInteractions = require('./handlers/verifyInteractions');
const giveawayInteractions = require('./handlers/giveawayInteractions');
const { handleMemberJoin } = require('./utils/welcome');
const api = require('./utils/api');
const { startDmQueue } = require('./utils/dmQueue');
const { startProductChannelSync } = require('./utils/productChannel');
const { startGiveawayScheduler } = require('./giveawayScheduler');
const security = require('./utils/security');
const activityLog = require('./utils/activityLog');

// Security-module: GuildMessages (anti-spam) en GuildModeration (anti-nuke,
// guildBanAdd) zijn NIET-privileged intents, dus daar hoef je niets voor aan
// te zetten in de Developer Portal.
//
// MessageContent is wel privileged en alleen nodig om invite-links in
// berichten te herkennen. Zet daarom pas SECURITY_MESSAGE_CONTENT=true in
// .env nadat je "Message Content Intent" in het Developer Portal hebt
// aangezet (Bot > Privileged Gateway Intents), anders kan de bot niet inloggen.
const intents = [
  // GuildMembers is a privileged intent — it must also be turned ON for
  // this bot in the Developer Portal ("Server Members Intent"), or
  // guildMemberAdd will never fire (welcome + anti-raid stop working).
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration,
];
if (process.env.SECURITY_MESSAGE_CONTENT === 'true') intents.push(GatewayIntentBits.MessageContent);

const client = new Client({ intents });

security.init(client);
activityLog.init(client);

client.commands = new Collection();

// ---- Load commands ----
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (!command?.data || !command?.execute) {
    logger.warn(`Command bestand ${file} mist 'data' of 'execute' — overgeslagen.`);
    continue;
  }
  client.commands.set(command.data.name, command);
}

logger.info(`${client.commands.size} commands geladen.`);

// ---- Ready ----
client.once('ready', async () => {
  logger.info(`Ingelogd als ${client.user.tag}`);
  client.user.setActivity(config.brand.activity);

  security.start(client).catch((err) => logger.error('Security-module starten mislukt:', err));

  // Reports every server the bot is currently in to the API, so the
  // dashboard's "kies een server" screen (after Discord login) knows
  // where the bot actually is. Non-fatal if it fails — the bot itself
  // keeps working either way.
  try {
    const guilds = client.guilds.cache.map((g) => ({ id: g.id, name: g.name, icon: g.iconURL() || null }));
    await api.syncDiscordGuilds(guilds);
    logger.info(`${guilds.length} servers gesynchroniseerd met de API voor het dashboard.`);
  } catch (err) {
    logger.error('Kon serverlijst niet synchroniseren met de API:', err);
  }

  // Webshop: stuurt periodiek klaarstaande DM's (nieuwe productversie,
  // aankoopbevestiging) die de API in de wachtrij heeft gezet.
  startDmQueue(client);

  // Webshop: houdt het via /product kanaal ingestelde overzichtskanaal
  // per server automatisch up-to-date.
  startProductChannelSync(client);

  // Giveaways: trekt automatisch winnaars zodra de timer van een
  // lopende giveaway afloopt.
  startGiveawayScheduler(client);
});

// Keeps the dashboard's server list live as the bot is added to / removed
// from servers, without waiting for the next restart.
client.on('guildCreate', async (guild) => {
  try {
    await api.upsertDiscordGuild(guild.id, guild.name, guild.iconURL() || null);
  } catch (err) {
    logger.error(`Kon nieuwe server ${guild.id} niet synchroniseren met de API:`, err);
  }
});

client.on('guildDelete', async (guild) => {
  try {
    await api.removeDiscordGuild(guild.id);
  } catch (err) {
    logger.error(`Kon verwijderde server ${guild.id} niet uit de API halen:`, err);
  }
});

// ---- Welcome messages ----
client.on('guildMemberAdd', async (member) => {
  try {
    // Eerst de beveiliging: is het lid geweerd (raid/te nieuw account),
    // dan slaan we het welkomstbericht over.
    const removed = await security.handleJoin(member).catch((err) => {
      logger.error(`Fout in anti-raid voor ${member.id}:`, err);
      return false;
    });
    activityLog.logJoin(member, removed).catch((err) => logger.error('Activiteiten-log (join) fout:', err));
    if (removed) return;

    await handleMemberJoin(member, api);
  } catch (err) {
    logger.error(`Fout bij afhandelen welkomstbericht voor ${member.id} in ${member.guild.id}:`, err);
  }
});

// ---- Interaction handling ----
client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;

    try {
      await command.autocomplete(interaction);
    } catch (err) {
      logger.error(`Fout bij autocomplete van /${interaction.commandName}:`, err);
    }
    return;
  }

  if (ticketInteractions.isTicketInteraction(interaction)) {
    try {
      await ticketInteractions.handleTicketInteraction(interaction);
    } catch (err) {
      logger.error('Fout bij ticket interactie:', err);
    }
    return;
  }

  if (verifyInteractions.isVerifyInteraction(interaction)) {
    try {
      await verifyInteractions.handleVerifyInteraction(interaction);
    } catch (err) {
      logger.error('Fout bij verify interactie:', err);
    }
    return;
  }

  if (giveawayInteractions.isGiveawayInteraction(interaction)) {
    try {
      await giveawayInteractions.handleGiveawayInteraction(interaction);
    } catch (err) {
      logger.error('Fout bij giveaway interactie:', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Onbekend command aangeroepen: ${interaction.commandName}`);
    return;
  }

  // Centralized permission check
  if (!permissions.canRunCommand(interaction, interaction.commandName)) {
    await interaction.reply({
      embeds: [embeds.error('Geen toegang', 'Je hebt geen toestemming om dit command te gebruiken.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await command.execute(interaction, { client, config, logger });
  } catch (err) {
    logger.error(`Fout bij uitvoeren van /${interaction.commandName}:`, err);

    const errorEmbed = embeds.error(
      'Er ging iets mis',
      'Er is een onverwachte fout opgetreden bij het uitvoeren van dit command. Probeer het later opnieuw.'
    );

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on('error', (err) => logger.error('Discord client error:', err));
process.on('unhandledRejection', (err) => logger.error('Unhandled promise rejection:', err));

// Inloggen met automatische herprobeerpoging en oplopende wachttijd.
// Zonder dit blijft de bot na een mislukte login (bv. Discord's
// "global rate limit" na te veel API-verzoeken in korte tijd) gewoon
// stil liggen tot de volgende handmatige herstart — en die herstart zelf
// (opnieuw commands registreren + opnieuw inloggen) verlengt vaak juist
// diezelfde blokkade. Met een backoff die vanzelf langer wacht, herstelt
// de bot zichzelf zodra Discord de blokkade opheft, zonder dat iemand
// hoeft te herdeployen.
const LOGIN_RETRY_START_MS = 30 * 1000; // 30 sec
const LOGIN_RETRY_MAX_MS = 10 * 60 * 1000; // 10 min

async function loginWithRetry(delayMs = LOGIN_RETRY_START_MS) {
  try {
    await client.login(config.discord.token);
  } catch (err) {
    logger.error(`Inloggen bij Discord mislukt (${err.message}); nieuwe poging over ${Math.round(delayMs / 1000)} sec.`);
    setTimeout(() => {
      loginWithRetry(Math.min(delayMs * 2, LOGIN_RETRY_MAX_MS));
    }, delayMs);
  }
}

loginWithRetry();
