require("dotenv").config();
const { startBot } = require("./bot");

// Standalone entrypoint: bot only, no web server. Only useful for local
// testing — the deployed service runs both together via ../server.js.
startBot().catch((err) => {
  console.error("[bot] Failed to start:", err);
  process.exit(1);
});
