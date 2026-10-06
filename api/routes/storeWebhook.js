// api/routes/storeWebhook.js
// Tebex stuurt hier een webhook naartoe zodra een betaling afrondt
// (https://docs.tebex.io/developers/webhooks/overview). Dit bestand exporteert
// bewust één losse Express-handler (geen router) omdat hij in server.js met
// express.raw() gemount moet worden VÓÓR de globale express.json() — de
// X-Signature-check heeft de ruwe, ongeparste request-body nodig; als
// express.json() 'm al had ingelezen, zou de verificatie altijd falen. Zet dit
// dus nooit achter de /store router, die wél express.json() gebruikt.

const crypto = require('crypto');
const config = require('../config');
const { db } = require('../database');
const {
  getPurchasesByOrderId,
  getProductRow,
  queuePendingDm,
  filterProductsWithFile,
  formatPrice,
} = require('../utils/storeHelpers');

// Tebex: HMAC-SHA256( sha256(rawBody), webhookSecret ), hex.
function validSignature(rawBody, header) {
  if (!header) return false;
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const expected = crypto.createHmac('sha256', config.tebex.webhookSecret).update(bodyHash).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// custom kan als object of als JSON-string terugkomen.
function readCustom(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function markPurchaseCompleted(payment) {
  const items = Array.isArray(payment.products) ? payment.products : [];
  const orderId = items.map((p) => readCustom(p.custom).orderId).find(Boolean);
  if (!orderId) {
    console.warn(`[STORE] Tebex-betaling ${payment.transaction_id} zonder orderId in custom data — genegeerd.`);
    return;
  }

  const rows = await getPurchasesByOrderId(orderId);
  if (rows.length === 0) {
    console.warn(`[STORE] Webhook voor onbekende bestelling ${orderId} — genegeerd.`);
    return;
  }

  // Tebex kan hetzelfde event meermaals afleveren — al afgeronde bestelling
  // niet nog eens verwerken/DM'en.
  if (rows.every((r) => r.status === 'completed')) return;

  const now = Date.now();
  const names = [];
  let total = 0;
  for (const row of rows) {
    const product = await getProductRow(row.product_id);
    if (product) names.push(product.version ? `${product.name} (v${product.version})` : product.name);

    // Wat er echt betaald is voor dit product (uit Tebex), anders het bedrag van de checkout.
    const paidItem = product && items.find((p) => String(p.id) === String(product.tebex_package_id));
    const paidAmount = paidItem && paidItem.paid_price && Number(paidItem.paid_price.amount);
    const amountCents = Number.isFinite(paidAmount) ? Math.round(paidAmount * 100) : row.amount_cents;
    total += amountCents;

    await db.execute({
      sql: `UPDATE purchases SET status = 'completed', tebex_transaction_id = ?, amount_cents = ?, purchased_at = ? WHERE id = ?`,
      args: [payment.transaction_id || null, amountCents, now, row.id],
    });
  }

  // Kortingscode pas hier als "gebruikt" tellen: de betaling is nu écht rond.
  const usedCode = (rows.find((r) => r.discount_code) || {}).discount_code;
  if (usedCode) {
    await db.execute({
      sql: 'UPDATE discount_codes SET used_count = used_count + 1 WHERE guild_id = ? AND code = ?',
      args: [rows[0].guild_id, usedCode],
    });
  }

  const fileIds = await filterProductsWithFile(rows.map((r) => r.product_id));
  const reviewLine = config.shopOrigin
    ? `\n\n⭐ Tevreden? Laat een review achter via [Mijn aankopen](${config.shopOrigin}/?guild=${rows[0].guild_id}#/account).`
    : '';

  await queuePendingDm(
    rows[0].discord_id,
    'Bestelbevestiging',
    `Bedankt voor je bestelling. Je betaling van ${formatPrice(total, rows[0].currency)} is ontvangen.\n\n**Producten**\n${names.map((n) => `• ${n}`).join('\n')}\n\nJe bestand${fileIds.length === 1 ? '' : 'en'} ${fileIds.length === 1 ? 'volgt' : 'volgen'} direct hieronder in dit gesprek.${reviewLine}`,
    fileIds
  );
}

// Express handler (NIET een router — zie uitleg bovenaan).
module.exports = async function tebexWebhookHandler(req, res) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  // Het validatie-bericht bij het toevoegen van het endpoint: alleen het id
  // terugsturen, er gebeurt niets mee. Zonder dit activeert Tebex het endpoint niet.
  if (event && event.type === 'validation.webhook') {
    return res.status(200).json({ id: event.id });
  }

  if (!config.tebex.webhookSecret) {
    console.error('[STORE] Tebex-webhook ontvangen maar TEBEX_WEBHOOK_SECRET is niet ingesteld.');
    return res.status(500).send('Tebex is niet geconfigureerd op de server.');
  }

  if (!validSignature(rawBody, req.headers['x-signature'])) {
    console.warn('[STORE] Ongeldige Tebex-webhook handtekening.');
    return res.status(401).send('Invalid signature');
  }

  try {
    if (event.type === 'payment.completed') {
      await markPurchaseCompleted(event.subject || {});
    } else if (event.type === 'payment.refunded' || String(event.type).startsWith('payment.dispute')) {
      // Alleen loggen: downloads blijven werken tot je ze zelf intrekt.
      const tx = event.subject && event.subject.transaction_id;
      console.warn(`[STORE] Tebex ${event.type} voor transactie ${tx || '?'} — controleer dit in je Tebex-panel.`);
    }
  } catch (err) {
    console.error('[STORE] Fout bij verwerken van Tebex-webhook:', err);
    // 500 teruggeven zodat Tebex het opnieuw probeert te bezorgen.
    return res.status(500).send('Internal error handling webhook');
  }

  res.json({ received: true });
};
