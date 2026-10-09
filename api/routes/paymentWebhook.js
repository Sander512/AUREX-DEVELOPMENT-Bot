// api/routes/paymentWebhook.js
// Mollie roept deze URL aan zodra de status van een betaling verandert
// (POST, application/x-www-form-urlencoded, body: id=tr_xxxxxxxx).
//
// Mollie ondertekent webhooks niet. De body wordt daarom nooit vertrouwd: we gebruiken alleen
// het payment-id om de betaling ZELF bij Mollie op te halen (met de secret key) en verwerken
// wat Mollie daar terugmeldt. Zo kan niemand een bestelling "betaald" maken met een nagemaakt
// verzoek. Mollie verwacht altijd een 200 (ook bij een onbekend id); een 5xx zorgt dat Mollie
// de melding later opnieuw stuurt.

const mollie = require('../utils/mollie');
const { getOrderByPaymentId, applyProviderPayment, logEvent } = require('../utils/orders');

const PAYMENT_ID = /^tr_[A-Za-z0-9]{4,64}$/;

module.exports = async function paymentWebhookHandler(req, res) {
  const id = req.body && typeof req.body.id === 'string' ? req.body.id.trim() : '';
  if (!PAYMENT_ID.test(id)) return res.status(200).send('ignored');

  if (!mollie.isConfigured()) {
    console.error('[STORE] Betaal-webhook ontvangen maar MOLLIE_API_KEY is niet ingesteld.');
    return res.status(500).send('Payments not configured');
  }

  try {
    const order = await getOrderByPaymentId(id);
    if (!order) {
      console.warn(`[STORE] Webhook voor onbekende betaling ${id} — genegeerd.`);
      return res.status(200).send('unknown');
    }

    const payment = await mollie.getPayment(id);
    await logEvent(order.id, id, 'webhook', 'received', `Mollie-status: ${payment.status}`);
    await applyProviderPayment(order, payment, 'webhook');
    return res.status(200).send('ok');
  } catch (err) {
    console.error('[STORE] Fout bij verwerken van betaal-webhook:', err);
    return res.status(500).send('Internal error handling webhook');
  }
};
