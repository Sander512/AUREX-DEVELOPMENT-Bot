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
// This entry point ALSO re-registers slash commands with Discord on boot
// (only when they've actually changed — see deploy-commands.js), so you
// never have to manually run `npm run deploy` on hosts (like Render)
// where you don't have easy shell access — add/rename/remove a command
// file, push, and the next restart picks it up automatically.

const deployCommands = require('./bot/deploy-commands');
const config = require('./api/config');

console.log('[START] Aurex | Development — gecombineerde modus (API + Bot in 1 proces)');

// Starts the Express API and binds to process.env.PORT / API_PORT.
const { ready: apiReady } = require('./api/server');

// ---------------------------------------------------------------------
// Keep-alive — voorkomt "De applicatie heeft niet op tijd gereageerd".
//
// Render's gratis Web Services gaan na een tijd zonder inkomend HTTP-
// verkeer in slaap. De uitgaande verbinding van de bot naar Discord telt
// daar NIET als verkeer voor, dus de hele container (bot + API) kan
// stilletjes stoppen terwijl hij in Discord nog "online" lijkt. Komt er
// dan een slash command binnen, dan moet Render eerst weer opstarten —
// dat duurt te lang voor Discord's limiet van 3 seconden, en je krijgt
// "De applicatie heeft niet op tijd gereageerd". Vandaar dat dit soms
// wel en soms niet werkt: het hangt af van hoe lang geleden de laatste
// activiteit was.
//
// Dit stuurt daarom elke paar minuten zelf een verzoek naar de eigen
// /health-route, zodat er altijd recent inkomend verkeer is en de
// service niet in slaap valt. Werkt alleen als PUBLIC_URL is ingesteld
// (nodig voor Discord-login toch al). Op een betaalde Render-plan (die
// niet in slaap gaat) doet dit verder geen kwaad — gewoon een paar extra
// lichte requests per uur.
function startKeepAlive() {
  if (!config.publicUrl) {
    console.warn('[START] PUBLIC_URL is niet ingesteld — kan geen keep-alive ping starten (kans op "niet op tijd gereageerd" bij inactiviteit).');
    return;
  }

  const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minuten — ruim binnen het "slaap na inactiviteit"-venster van gratis hosting

  const ping = async () => {
    try {
      const res = await fetch(`${config.publicUrl}/health`);
      if (!res.ok) console.warn(`[KEEP-ALIVE] /health gaf status ${res.status}.`);
    } catch (err) {
      // Bewust stil verder: één gemiste ping is geen probleem, de
      // volgende poging volgt vanzelf.
      console.warn(`[KEEP-ALIVE] Ping mislukt (${err.message}); volgende poging over ${PING_INTERVAL_MS / 60000} min.`);
    }
  };

  setInterval(ping, PING_INTERVAL_MS);
  ping(); // meteen één keer, niet pas na het eerste interval
  console.log(`[START] Keep-alive actief: elke ${PING_INTERVAL_MS / 60000} minuten een ping naar ${config.publicUrl}/health.`);
}

(async () => {
  // Wacht tot de API echt klaar is (initDb() gedraaid, poort gebonden)
  // vóórdat we iets doen dat de database nodig heeft (command-hash
  // opzoeken) of de bot laten inloggen — anders race conditions.
  await apiReady;

  try {
    await deployCommands();
  } catch (err) {
    // Don't crash the whole service over a failed command sync — the bot
    // and API can still function with whatever commands were last
    // registered. Just log it loudly so it's visible in the logs.
    console.error('[START] Slash command registratie mislukt (bot start toch door):', err);
  }

  startKeepAlive();

  // Logs the Discord bot in and starts listening for interactions.
  require('./bot/index');
})();
