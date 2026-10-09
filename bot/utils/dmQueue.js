// bot/utils/dmQueue.js
// Polling loop that empties the `pending_dms` queue the API fills (see
// api/routes/store.js and api/routes/storeWebhook.js). The API has no
// Discord connection of its own, so this is how a "Stuur update" click
// in the dashboard, or a completed payment, actually turns into a
// real DM — the bot is the only part of this app that can send one.

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const api = require('./api');
const logger = require('./logger');
const config = require('../config');

const POLL_INTERVAL_MS = 20 * 1000;

// Discord's eigen limiet voor een bijlage in een DM (geen serverboost van
// toepassing buiten een guild) ligt doorgaans rond de 10 MB voor een
// gewone bot-account. We houden ruim marge aan: boven deze grens proberen
// we het niet eens als bijlage — dat zou Discord toch weigeren — en
// sturen we in plaats daarvan een downloadlink naar de website.
const SAFE_DM_ATTACHMENT_BYTES = 9 * 1024 * 1024; // 9 MB

// Bouwt de embed rechtstreeks op zodat de titel exact blijft zoals de API hem meegeeft.
function buildEmbed(dm, extraNote) {
  const description = [dm.embedDescription, extraNote].filter(Boolean).join('\n\n');
  return new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: `© ${config.brand.name}` })
    .setColor(config.colors.info)
    .setTitle(dm.embedTitle)
    .setDescription(description || null);
}

let cachedAccountUrl = null;
async function getAccountUrl() {
  if (cachedAccountUrl !== undefined && cachedAccountUrl !== null) return cachedAccountUrl;
  try {
    const shopCfg = await api.getShopConfig();
    cachedAccountUrl = shopCfg.shopUrl ? `${shopCfg.shopUrl}/#/account` : null;
  } catch {
    cachedAccountUrl = null;
  }
  return cachedAccountUrl;
}

// Haalt voor elk product-id eerst alleen de bestandsgrootte op. Bestanden
// die als DM-bijlage passen worden volledig opgehaald; te grote bestanden
// slaan we over (met een linkje naar "Mijn aankopen" i.p.v. de bijlage) —
// zo laden we nooit onnodig een heel groot bestand in het geheugen.
async function collectFiles(fileProductIds) {
  const attachments = [];
  let skippedCount = 0;

  for (const productId of fileProductIds || []) {
    let meta;
    try {
      meta = await api.getProductFileMeta(productId);
    } catch (err) {
      logger.warn(`Kon bestandsgrootte voor product ${productId} niet ophalen: ${err.message}`);
      continue;
    }

    if (meta.sizeBytes > SAFE_DM_ATTACHMENT_BYTES) {
      skippedCount += 1;
      continue;
    }

    try {
      const f = await api.getProductFile(productId);
      attachments.push(new AttachmentBuilder(Buffer.from(f.dataBase64, 'base64'), { name: f.fileName }));
    } catch (err) {
      logger.warn(`Kon bestand voor product ${productId} niet ophalen: ${err.message}`);
      skippedCount += 1;
    }
  }

  return { attachments, skippedCount };
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
      const { attachments, skippedCount } = await collectFiles(dm.fileProductIds);

      let extraNote = null;
      if (skippedCount > 0) {
        const accountUrl = await getAccountUrl();
        const plural = skippedCount === 1 ? 'bestand is' : `${skippedCount} bestanden zijn`;
        extraNote = accountUrl
          ? `📎 ${plural} te groot om als DM te versturen — download het via [Mijn aankopen](${accountUrl}) op de website.`
          : `📎 ${plural} te groot om als DM te versturen — log in op de website en ga naar "Mijn aankopen" om te downloaden.`;
      }

      await user.send({ embeds: [buildEmbed(dm, extraNote)] });
      // Eén bericht per bestand, zodat de bijlage-limiet van Discord per bericht niet overschreden wordt.
      for (const file of attachments) {
        await user.send({ files: [file] });
      }
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
