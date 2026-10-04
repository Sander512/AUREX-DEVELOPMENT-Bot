// bot/giveawayScheduler.js
// Polls the API every 20s for active giveaways whose timer has run out and
// draws winners for them automatically — the same mechanism /giveaway-end
// uses, just triggered by the clock instead of a command.

const api = require('./utils/api');
const logger = require('./utils/logger');
const { drawGiveaway } = require('./utils/giveaways');

const POLL_INTERVAL_MS = 20_000;

async function tick(client) {
  let giveaways;
  try {
    ({ giveaways } = await api.getActiveGiveaways());
  } catch (err) {
    logger.error(`Kon actieve giveaways niet ophalen: ${err.message}`);
    return;
  }

  const due = giveaways.filter((g) => g.endsAt <= Date.now());

  for (const giveaway of due) {
    try {
      await drawGiveaway({ client, giveaway, api });
      logger.info(`Giveaway #${giveaway.id} (${giveaway.prize}) automatisch beëindigd.`);
    } catch (err) {
      logger.error(`Kon giveaway #${giveaway.id} niet automatisch beëindigen: ${err.message}`);
    }
  }
}

function startGiveawayScheduler(client) {
  setInterval(() => {
    tick(client).catch((err) => logger.error('Fout in giveaway scheduler:', err));
  }, POLL_INTERVAL_MS);
}

module.exports = { startGiveawayScheduler };
