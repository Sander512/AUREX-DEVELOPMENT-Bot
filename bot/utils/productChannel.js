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

const MAX_PRODUCT_EMBEDS = 9; // Discord: max 10 embeds per bericht (1 kop + 9 producten)

function stars(avg, count) {
  if (!count) return null;
  const full = Math.round(avg);
  return `${'★'.repeat(full)}${'☆'.repeat(5 - full)} ${avg.toFixed(1)} (${count})`;
}

// Eén kop-embed + een kaartje per product (nieuwste eerst) met de cover als
// miniatuur, prijs, versie en review-score.
async function buildOverviewEmbeds(guildId) {
  const [{ products }, shopCfg] = await Promise.all([
    api.getPublicProducts(guildId),
    api.getShopConfig().catch(() => ({})),
  ]);

  const shopBase = shopCfg.shopUrl ? `${shopCfg.shopUrl}/?guild=${guildId}` : null;

  const header = new EmbedBuilder()
    .setColor(config.colors.primary)
    .setTitle('Webshop — huidig aanbod')
    .setFooter({ text: `© ${config.brand.name}` })
    .setTimestamp();
  if (shopBase) header.setURL(shopBase);

  if (products.length === 0) {
    header.setDescription(
      shopBase ? `Er staan momenteel geen producten in de webshop.\n\n[Naar de webshop](${shopBase})` : 'Er staan momenteel geen producten in de webshop.'
    );
    return [header];
  }

  const newestFirst = [...products].reverse(); // API geeft oudste eerst
  const shown = newestFirst.slice(0, MAX_PRODUCT_EMBEDS);

  let intro = `${products.length} product${products.length === 1 ? '' : 'en'} beschikbaar.`;
  if (newestFirst.length > shown.length) intro += ` Hieronder de ${shown.length} nieuwste — de rest staat in de webshop.`;
  if (shopBase) intro += `\n\n[Bekijk de hele webshop](${shopBase}#/shop)`;
  header.setDescription(intro);

  const cards = shown.map((p) => {
    const link = shopBase ? `${shopBase}#/product/${encodeURIComponent(p.id)}` : null;
    const bits = [`**${formatPrice(p.priceCents, p.currency)}**`];
    if (p.version) bits.push(`v${p.version}`);
    if (p.category) bits.push(p.category);
    const rating = stars(p.ratingAvg || 0, p.ratingCount || 0);
    const lines = [bits.join(' · ')];
    if (rating) lines.push(rating);
    if (p.isBestseller) lines.push('🏆 Bestseller');

    const card = new EmbedBuilder().setColor(config.colors.primary).setTitle(p.name.slice(0, 256)).setDescription(lines.join('\n'));
    if (link) card.setURL(link);
    if (p.imageUrls && p.imageUrls[0] && /^https?:\/\//.test(p.imageUrls[0])) card.setThumbnail(p.imageUrls[0]);
    return card;
  });

  return [header, ...cards];
}

async function refreshChannel(client, { guildId, channelId, messageId }) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.warn(`Kon webshop-overzichtskanaal ${channelId} (server ${guildId}) niet vinden: ${err.message}`);
    return;
  }

  let embeds;
  try {
    embeds = await buildOverviewEmbeds(guildId);
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
      await message.edit({ embeds });
      await api.ackProductChannel(guildId, message.id);
    } else {
      const sent = await channel.send({ embeds });
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
