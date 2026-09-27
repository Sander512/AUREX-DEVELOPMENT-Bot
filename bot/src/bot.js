const { Client, GatewayIntentBits, Collection, Partials } = require("discord.js");
const { loadCommands } = require("./handlers/loadCommands");
const { loadEvents } = require("./handlers/loadEvents");

/**
 * Creates, configures and logs in the Discord client. Called from
 * server.js (bot + web in one process) or from index.js (standalone bot,
 * no web server — useful for local testing without Next.js involved).
 */
async function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.commands = new Collection();

  loadCommands(client);
  loadEvents(client);

  await client.login(process.env.DISCORD_TOKEN);

  return client;
}

process.on("unhandledRejection", (err) => {
  console.error("[process] Unhandled rejection:", err);
});

module.exports = { startBot };
