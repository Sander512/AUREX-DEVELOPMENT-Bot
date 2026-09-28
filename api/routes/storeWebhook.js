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
const { getPurchaseByStripeSessionId, getProductRow, queuePendingDm, formatPrice } = require('../utils/storeHelpers');

const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;

async function markPurchaseCompleted(session) {
  const purchase = await getPurchaseByStripeSessionId(session.id);
  if (!purchase) {
    console.warn(`[STORE] Webhook voor onbekende Stripe session ${session.id} — genegeerd.`);
    return;
  }

  // Stripe kan hetzelfde event meermaals afleveren (at-least-once
  // delivery) — als deze aankoop al 'completed' is, niet nog een keer
  // een bevestigings-DM versturen.
  if (purchase.status === 'completed') return;

  const now = Date.now();
  await db.execute({
    sql: `UPDATE purchases SET status = 'completed', stripe_payment_intent = ?, purchased_at = ? WHERE id = ?`,
    args: [session.payment_intent || null, now, purchase.id],
  });

  const product = await getProductRow(purchase.product_id);
  if (product) {
    await queuePendingDm(
      purchase.discord_id,
      `✅ Bedankt voor je aankoop: ${product.name}`,
      `Je betaling van ${formatPrice(purchase.amount_cents, purchase.currency)} is gelukt en je aankoop staat genoteerd.` +
        (product.version ? `\n\n**Huidige versie:** ${product.version}` : '')
    );
  }
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
