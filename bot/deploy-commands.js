// bot/deploy-commands.js
// Registers all slash commands to the configured guild.
//
// Can be run standalone: npm run deploy
// Or imported and called programmatically (used by start.js to auto-sync
// commands on every boot, so you never need to run this by hand on a host
// like Render where you don't have easy shell access).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REST, Routes } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const { getSetting, setSetting } = require('../api/database');

const SETTINGS_KEY = 'deployed_commands_hash';

function loadCommandDefinitions() {
  const commands = [];
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command?.data) {
      logger.warn(`Command bestand ${file} mist 'data' — overgeslagen.`);
      continue;
    }
    commands.push(command.data.toJSON());
  }

  // Stabiele volgorde nodig, anders verandert de hash bij elke boot puur
  // door de willekeurige leesvolgorde van de map, ook als er niets wijzigde.
  commands.sort((a, b) => a.name.localeCompare(b.name));

  return commands;
}

function hashCommands(commands) {
  return crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex');
}

// force=true negeert de opgeslagen hash en pusht altijd (gebruikt door
// `npm run deploy`, zodat een handmatige run nooit stilletjes niets doet).
async function deployCommands({ force = false } = {}) {
  const commands = loadCommandDefinitions();
  const hash = hashCommands(commands);

  if (!force) {
    let previousHash = null;
    try {
      previousHash = await getSetting(SETTINGS_KEY);
    } catch (err) {
      // Database nog niet bereikbaar/klaar — dan liever gewoon pushen dan
      // de boot laten mislukken over een optimalisatie.
      logger.warn(`Kon vorige command-hash niet ophalen, commands worden voor de zekerheid opnieuw geregistreerd: ${err.message}`);
    }

    if (previousHash === hash) {
      logger.info(`Slash commands ongewijzigd (${commands.length}) — registratie bij Discord overgeslagen.`);
      return null;
    }
  }

  const rest = new REST().setToken(config.discord.token);

  logger.info(`Registreren van ${commands.length} slash commands...`);

  const data = await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: commands }
  );

  logger.info(`${data.length} slash commands succesvol geregistreerd.`);

  try {
    await setSetting(SETTINGS_KEY, hash);
  } catch (err) {
    // Niet fataal: in het ergste geval wordt er bij de volgende boot nog
    // eens (onnodig) gepusht.
    logger.warn(`Kon command-hash niet opslaan: ${err.message}`);
  }

  return data;
}

// Only auto-run when executed directly (npm run deploy), not when required
// as a module from start.js.
if (require.main === module) {
  deployCommands({ force: true }).catch((err) => {
    logger.error('Fout bij registreren van commands:', err);
    process.exit(1);
  });
}

module.exports = deployCommands;
