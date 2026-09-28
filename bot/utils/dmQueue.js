// bot/utils/dmQueue.js
// Polling loop that empties the `pending_dms` queue the API fills (see
// api/routes/store.js and api/routes/storeWebhook.js). The API has no
// Discord connection of its own, so this is how a "Stuur update" click
// in the dashboard, or a completed Stripe payment, actually turns into a
// real DM — the bot is the only part of this app that can send one.

const { EmbedBuilder } = require('discord.js');
const api = require('./api');
const logger = require('./logger');
const config = require('../config');

const POLL_INTERVAL_MS = 20 * 1000;

// Bouwt de embed rechtstreeks op (i.p.v. embeds.info) omdat embed_title
// hier al zijn eigen emoji bevat ("🔔 Update voor ...", "✅ Bedankt voor
// je aankoop: ...") — embeds.info zou daar nog eens "ℹ️ " voor plakken.
function buildEmbed(dm) {
  return new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: `© ${config.brand.name}` })
    .setColor(config.colors.info)
    .setTitle(dm.embedTitle)
    .setDescription(dm.embedDescription || null);
}

async function processOnce(client) {
  let dms;
  try {
    ({ dms } = await api.getPendingDms(10));
  } catch (err) {
    logger.error('Kon DM-wachtrij niet ophalen bij de API:', err);
    return;
  }

  for (const dm of dms) {
    try {
      const user = await client.users.fetch(dm.discordId);
      await user.send({ embeds: [buildEmbed(dm)] });
      await api.markDmStatus(dm.id, 'sent');
    } catch (err) {
      // Meestal: gebruiker heeft DM's van serverleden/de bot uitstaan.
      // Niet blijven proberen — gewoon als mislukt markeren en doorgaan.
      logger.warn(`Kon geen DM sturen naar ${dm.discordId} (${err.message}) — als 'failed' gemarkeerd.`);
      try {
        await api.markDmStatus(dm.id, 'failed');
      } catch (markErr) {
        logger.error(`Kon DM ${dm.id} niet als 'failed' markeren:`, markErr);
      }
    }
  }
}

// Start de polling-loop. Non-fatal bij fouten — dit mag de bot nooit
// laten crashen, het is puur een achtergrondtaakje.
function startDmQueue(client) {
  setInterval(() => {
    processOnce(client).catch((err) => logger.error('Onverwachte fout in DM-wachtrij:', err));
  }, POLL_INTERVAL_MS);
}

module.exports = { startDmQueue };
