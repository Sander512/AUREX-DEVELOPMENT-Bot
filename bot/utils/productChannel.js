// bot/utils/productChannel.js
// Houdt één bericht per server up-to-date met alles wat momenteel in de
// webshop staat (zie /product kanaal). Werkt net als de DM-wachtrij: de
// API (die geen Discord-verbinding heeft) zet een kanaal op "dirty" zodra
// het aanbod verandert — via een bot-commando óf via het dashboard — en
// deze module pollt dat periodiek leeg.

const { EmbedBuilder } = require('discord.js');
const api = require('./api');
const logger = require('./logger');
const config = require('../config');

const POLL_INTERVAL_MS = 20 * 1000;
const MAX_LISTED = 25; // embed-veldlimiet, ruim genoeg voor een webshop-overzicht

function formatPrice(cents, currency) {
  if (cents === 0) return 'Gratis';
  return `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
}

async function buildOverviewEmbed(guildId) {
  const [{ products }, shopCfg] = await Promise.all([
    api.getPublicProducts(guildId),
    api.getShopConfig().catch(() => ({})),
  ]);

  const shopBase = shopCfg.shopUrl ? `${shopCfg.shopUrl}/?guild=${guildId}` : null;

  const embed = new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: `© ${config.brand.name}` })
    .setColor(config.colors.primary)
    .setTitle('Webshop — huidig aanbod');

  if (shopBase) embed.setURL(shopBase);

  if (products.length === 0) {
    embed.setDescription(
      shopBase ? `Er staan momenteel geen producten in de webshop.\n\n[Naar de webshop](${shopBase})` : 'Er staan momenteel geen producten in de webshop.'
    );
    return embed;
  }

  const newestFirst = [...products].reverse(); // API geeft oudste eerst
  const shown = newestFirst.slice(0, MAX_LISTED);

  const lines = shown.map((p) => {
    const price = formatPrice(p.priceCents, p.currency);
    const link = shopBase ? `${shopBase}#/product/${encodeURIComponent(p.id)}` : null;
    const name = link ? `[${p.name}](${link})` : p.name;
    const version = p.version ? ` · v${p.version}` : '';
    return `• ${name} — ${price}${version}`;
  });

  let description = lines.join('\n');
  if (newestFirst.length > shown.length) description += `\n\n*+ ${newestFirst.length - shown.length} meer in de webshop.*`;
  if (shopBase) description += `\n\n[Bekijk de hele webshop](${shopBase})`;

  embed.setDescription(description);
  return embed;
}

async function refreshChannel(client, { guildId, channelId, messageId }) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.warn(`Kon webshop-overzichtskanaal ${channelId} (server ${guildId}) niet vinden: ${err.message}`);
    return;
  }

  let embed;
  try {
    embed = await buildOverviewEmbed(guildId);
  } catch (err) {
    logger.error(`Kon webshop-overzicht voor server ${guildId} niet opbouwen:`, err);
    return;
  }

  let message = null;
  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch {
      message = null; // Verwijderd of niet meer vindbaar — nieuwe versturen.
    }
  }

  try {
    if (message) {
      await message.edit({ embeds: [embed] });
      await api.ackProductChannel(guildId, message.id);
    } else {
      const sent = await channel.send({ embeds: [embed] });
      await api.ackProductChannel(guildId, sent.id);
    }
  } catch (err) {
    logger.error(`Kon webshop-overzicht in kanaal ${channelId} (server ${guildId}) niet bijwerken:`, err);
  }
}

// Ververst het overzicht van één server meteen (bv. na /product kanaal, of
// vlak na een add/update/delete voor direct zichtbaar resultaat). Stil als
// er geen kanaal is ingesteld.
async function refreshGuildNow(client, guildId) {
  let cfg;
  try {
    ({ config: cfg } = await api.getProductChannel(guildId));
  } catch (err) {
    logger.error(`Kon webshop-kanaalinstelling voor server ${guildId} niet ophalen:`, err);
    return;
  }
  if (!cfg) return;
  await refreshChannel(client, cfg);
}

async function pollDirtyChannels(client) {
  let configs;
  try {
    ({ configs } = await api.getDirtyProductChannels());
  } catch (err) {
    logger.error('Kon lijst met bij te werken webshop-kanalen niet ophalen:', err);
    return;
  }
  for (const cfg of configs) {
    await refreshChannel(client, cfg);
  }
}

function startProductChannelSync(client) {
  setInterval(() => {
    pollDirtyChannels(client).catch((err) => logger.error('Onverwachte fout bij webshop-kanaal sync:', err));
  }, POLL_INTERVAL_MS);
}

module.exports = { startProductChannelSync, refreshGuildNow };
