// start.js
// Combined entry point: runs the Aurex | Development API and the Discord bot
// in a single Node.js process. Use this when you only want (or can only
// afford) ONE hosted service — e.g. a single Render Web Service — instead
// of a separate API service + background worker.
//
// Run with: node start.js
// (or: npm run start:all)
//
// Why this works: Render (and most PaaS providers) require a Web Service
// to bind to the assigned $PORT. The bot itself doesn't need a port — it
// connects out to Discord's gateway — so by loading both in the same
// process, Render sees the API's app.listen() as the "web service" while
// the bot quietly runs alongside it in the background.
//
// This entry point ALSO re-registers all slash commands with Discord on
// every boot, so you never have to manually run `npm run deploy` on hosts
// (like Render) where you don't have easy shell access — add/rename/remove
// a command file, push, and the next restart picks it up automatically.

const deployCommands = require('./bot/deploy-commands');

console.log('[START] Aurex | Development — gecombineerde modus (API + Bot in 1 proces)');

// Starts the Express API and binds to process.env.PORT / API_PORT.
const { ready: apiReady } = require('./api/server');

(async () => {
  try {
    await deployCommands();
  } catch (err) {
    // Don't crash the whole service over a failed command sync — the bot
    // and API can still function with whatever commands were last
    // registered. Just log it loudly so it's visible in the logs.
    console.error('[START] Slash command registratie mislukt (bot start toch door):', err);
  }

  // Wait until the API has actually finished initDb() and bound to its
  // port before letting the bot log in — otherwise the bot's 'ready'
  // handler can fire (and try to sync its guild list to the API) before
  // the API is listening, which fails with ECONNREFUSED / "fetch failed".
  await apiReady;

  // Logs the Discord bot in and starts listening for interactions.
  require('./bot/index');
})();
