// api/utils/mollie.js
// Kleine client voor de Mollie Payments API (https://docs.mollie.com/reference/v2/payments-api/create-payment).
// De secret key (MOLLIE_API_KEY) wordt alleen hier op de server gebruikt.
//
// Beveiligingsmodel van de webhook: Mollie ondertekent webhooks niet; de webhook bevat
// alleen een payment-id. Wij vertrouwen dus NOOIT de inhoud van het verzoek, maar halen de
// betaling zelf op bij Mollie met onze secret key. Een nagemaakt verzoek kan daardoor nooit
// een bestelling op "betaald" zetten.

const config = require('../config');

const API = 'https://api.mollie.com/v2';

function isConfigured() {
  return !!config.payments.mollieApiKey;
}

async function request(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${config.payments.mollieApiKey}`,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* geen JSON */
  }

  if (!res.ok) {
    const err = new Error((json && (json.detail || json.title)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

// Mollie-status -> onze orderstatus: pending | paid | failed | canceled
function mapStatus(mollieStatus) {
  switch (mollieStatus) {
    case 'paid':
      return 'paid';
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'expired':
      return 'failed';
    default:
      return 'pending'; // open, pending, authorized
  }
}

// Geeft { id, checkoutUrl, status }.
async function createPayment({ amountCents, currency, description, redirectUrl, webhookUrl, metadata, idempotencyKey }) {
  const body = {
    amount: { currency: String(currency).toUpperCase(), value: formatAmount(amountCents) },
    description,
    redirectUrl,
    locale: 'nl_NL',
    metadata,
  };
  // Mollie weigert een webhook-URL die ze niet kunnen bereiken (bv. http://localhost).
  // Zonder webhook valt de site terug op status-controle bij het terugkeren (zie utils/orders.js).
  if (webhookUrl && /^https:\/\//i.test(webhookUrl)) body.webhookUrl = webhookUrl;

  const payment = await request('/payments', { method: 'POST', body, idempotencyKey });
  const checkoutUrl = payment && payment._links && payment._links.checkout && payment._links.checkout.href;
  if (!payment || !payment.id || !checkoutUrl) throw new Error('Mollie gaf geen betaal-link terug');
  return { id: payment.id, checkoutUrl, status: payment.status };
}

async function getPayment(id) {
  return request(`/payments/${encodeURIComponent(id)}`);
}

module.exports = { isConfigured, createPayment, getPayment, mapStatus, formatAmount };
