// api/utils/tebex.js
// Kleine client voor de Tebex Headless API (https://docs.tebex.io/developers/headless-api).
// Gebruikt alleen de public token — geen private key nodig. Een Node-versie met
// ingebouwde fetch is genoeg (>= 18, zie package.json).
//
// Flow: basket aanmaken -> packages toevoegen -> (optioneel) coupon toepassen ->
// klant doorsturen naar links.checkout. Dat een betaling gelukt is komt NIET uit
// de browser maar uit de webhook (zie routes/storeWebhook.js).

const config = require('../config');

const API = 'https://headless.tebex.io/api';

function isConfigured() {
  return !!(config.tebex.publicToken && config.tebex.webhookSecret);
}

async function request(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
    const detail = json && (json.detail || json.message || json.error || json.title);
    const err = new Error(detail ? String(detail) : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Voegt één package toe. De docs noemen dit endpoint zonder token in het pad;
// bij een 404 proberen we de variant mét /accounts/{token}.
async function addPackage(ident, packageId, custom) {
  const body = { package_id: String(packageId), quantity: 1, custom };
  try {
    return await request(`${API}/baskets/${ident}/packages`, { method: 'POST', body });
  } catch (err) {
    if (err.status !== 404) throw err;
    return request(`${API}/accounts/${config.tebex.publicToken}/baskets/${ident}/packages`, { method: 'POST', body });
  }
}

// packageIds: Tebex package-id's (strings). custom: wordt per package mee teruggestuurd in de webhook.
// Geeft { ident, checkoutUrl }.
async function createCheckout({ packageIds, custom, completeUrl, cancelUrl, couponCode }) {
  const token = config.tebex.publicToken;

  const created = await request(`${API}/accounts/${token}/baskets`, {
    method: 'POST',
    body: { complete_url: completeUrl, cancel_url: cancelUrl, complete_auto_redirect: true, custom },
  });
  const ident = created && created.data && created.data.ident;
  if (!ident) throw new Error('Tebex gaf geen basket terug');

  let basket = created.data;
  for (const packageId of packageIds) {
    const added = await addPackage(ident, packageId, custom);
    if (added && added.data) basket = added.data;
  }

  if (couponCode) {
    let applied;
    try {
      applied = await request(`${API}/accounts/${token}/baskets/${ident}/coupons`, { method: 'POST', body: { coupon_code: couponCode } });
    } catch (err) {
      const e = new Error('coupon');
      e.couponRejected = true;
      throw e;
    }
    if (applied && applied.success === false) {
      const e = new Error('coupon');
      e.couponRejected = true;
      throw e;
    }
  }

  let checkoutUrl = basket && basket.links && basket.links.checkout;
  if (!checkoutUrl || couponCode) {
    // Na een coupon is de checkout-link van vóór de coupon nog geldig, maar we halen
    // de basket opnieuw op zodat we zeker de actuele link hebben.
    const fresh = await request(`${API}/accounts/${token}/baskets/${ident}`);
    checkoutUrl = fresh && fresh.data && fresh.data.links && fresh.data.links.checkout;
  }
  if (!checkoutUrl) throw new Error('Tebex gaf geen afreken-link terug');

  return { ident, checkoutUrl };
}

module.exports = { isConfigured, createCheckout };
