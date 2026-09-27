const fs = require("fs");
const path = require("path");

/**
 * Recursively loads every command file under src/commands into a
 * Collection keyed by command name. Each command file must export
 * { data: SlashCommandBuilder, execute(interaction) }.
 */
function loadCommands(client) {
  const commandsPath = path.join(__dirname, "..", "commands");
  const folders = fs.readdirSync(commandsPath);

  for (const folder of folders) {
    const folderPath = path.join(commandsPath, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;

    const files = fs.readdirSync(folderPath).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const command = require(path.join(folderPath, file));
      if (!command?.data || !command?.execute) {
        console.warn(`[commands] Skipping ${file}: missing data/execute`);
        continue;
      }
      client.commands.set(command.data.name, command);
    }
  }

  console.log(`[commands] Loaded ${client.commands.size} commands`);
}

module.exports = { loadCommands };
