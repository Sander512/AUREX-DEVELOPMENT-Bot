// api/routes/storeWebhook.js
// Stripe stuurt hier een event naartoe zodra een Checkout Session
// afrondt. Dit bestand exporteert bewust één losse Express-handler (geen
// router) omdat hij in server.js met express.raw() gemount moet worden
// VÓÓR de globale express.json() — Stripe's handtekening-check
// (stripe.webhooks.constructEvent) heeft de ruwe, ongeparste request-body
// nodig; als express.json() 'm al had ingelezen, zou de verificatie altijd
// falen. Zet dit dus nooit achter de /store router, die wél express.json()
// gebruikt.

const config = require('../config');
const { db } = require('../database');
const {
  getPurchaseByStripeSessionId,
  getPurchasesByOrderId,
  getProductRow,
  queuePendingDm,
  filterProductsWithFile,
  formatPrice,
} = require('../utils/storeHelpers');

const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;

async function markPurchaseCompleted(session) {
  // Nieuwe bestellingen (winkelwagen) zoeken we via order_id in de
  // metadata; oudere losse aankopen via de Stripe session id.
  const orderId = session.metadata && session.metadata.orderId;
  let rows = orderId ? await getPurchasesByOrderId(orderId) : [];
  if (rows.length === 0) {
    const legacy = await getPurchaseByStripeSessionId(session.id);
    rows = legacy ? [legacy] : [];
  }

  if (rows.length === 0) {
    console.warn(`[STORE] Webhook voor onbekende Stripe session ${session.id} — genegeerd.`);
    return;
  }

  // Stripe kan hetzelfde event meermaals afleveren (at-least-once
  // delivery) — al afgeronde bestelling niet nog eens verwerken/DM'en.
  if (rows.every((r) => r.status === 'completed')) return;

  const now = Date.now();
  for (const row of rows) {
    await db.execute({
      sql: `UPDATE purchases SET status = 'completed', stripe_payment_intent = ?, purchased_at = ? WHERE id = ?`,
      args: [session.payment_intent || null, now, row.id],
    });
  }

  const names = [];
  let total = 0;
  for (const row of rows) {
    const product = await getProductRow(row.product_id);
    if (product) names.push(product.version ? `${product.name} (v${product.version})` : product.name);
    total += row.amount_cents;
  }

  // Kortingscode pas hier als "gebruikt" tellen: de betaling is nu écht rond.
  const usedCode = session.metadata && session.metadata.discountCode;
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
module.exports = async function stripeWebhookHandler(req, res) {
  if (!stripe || !config.stripe.webhookSecret) {
    console.error('[STORE] Stripe-webhook ontvangen maar STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET is niet ingesteld.');
    return res.status(500).send('Stripe is niet geconfigureerd op de server.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (err) {
    console.warn(`[STORE] Ongeldige Stripe-webhook handtekening: ${err.message}`);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await markPurchaseCompleted(event.data.object);
    }
    // Vangt ook het geval af waarin een async betaalmethode pas later
    // definitief bevestigd wordt.
    if (event.type === 'checkout.session.async_payment_succeeded') {
      await markPurchaseCompleted(event.data.object);
    }
  } catch (err) {
    console.error('[STORE] Fout bij verwerken van Stripe-webhook:', err);
    // 500 teruggeven zodat Stripe het opnieuw probeert te bezorgen.
    return res.status(500).send('Internal error handling webhook');
  }

  res.json({ received: true });
};
