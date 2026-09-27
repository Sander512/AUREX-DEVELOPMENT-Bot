// bot/deploy-commands.js
// Registers all slash commands to the configured guild.
//
// Can be run standalone: npm run deploy
// Or imported and called programmatically (used by start.js to auto-sync
// commands on every boot, so you never need to run this by hand on a host
// like Render where you don't have easy shell access).

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');

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

  return commands;
}

async function deployCommands() {
  const commands = loadCommandDefinitions();
  const rest = new REST().setToken(config.discord.token);

  logger.info(`Registreren van ${commands.length} slash commands...`);

  const data = await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: commands }
  );

  logger.info(`${data.length} slash commands succesvol geregistreerd.`);
  return data;
}

// Only auto-run when executed directly (npm run deploy), not when required
// as a module from start.js.
if (require.main === module) {
  deployCommands().catch((err) => {
    logger.error('Fout bij registreren van commands:', err);
    process.exit(1);
  });
}

module.exports = deployCommands;
