// api/utils/orders.js
// Alles rond bestellingen van de eigen checkout: order-ID's, statusovergangen,
// verwerking van een geslaagde betaling en synchronisatie met de betaalprovider.
//
// Regels die hier bewaakt worden:
//   * Een bestelling wordt ALLEEN "paid" op basis van een betaling die wij zelf bij Mollie
//     hebben opgehaald (webhook of status-check) — nooit door iets wat de browser stuurt.
//   * Levering (purchases afronden, kortingscode tellen, DM met bestand) gebeurt precies één
//     keer, ook als de webhook meerdere keren of gelijktijdig binnenkomt.
//   * Een betaald bedrag dat niet klopt met de bestelling wordt NIET geleverd maar gelogd.

const crypto = require('crypto');
const { db } = require('../database');
const mollie = require('./mollie');
const { queuePendingDm, filterProductsWithFile, formatPrice } = require('./storeHelpers');

const STATUS_LABELS = {
  pending: 'Wachten op betaling',
  paid: 'Betaald',
  failed: 'Mislukt',
  canceled: 'Geannuleerd',
};

// Geen 0/O/1/I/L: voorkomt overtypfouten als een klant zijn nummer doorgeeft.
const ORDER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateOrderNumber(now = new Date()) {
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  let rand = '';
  for (let i = 0; i < 6; i++) rand += ORDER_ALPHABET[crypto.randomInt(ORDER_ALPHABET.length)];
  return `AX-${yy}${mm}${dd}-${rand}`;
}

async function logEvent(orderId, paymentId, source, event, detail) {
  try {
    await db.execute({
      sql: `INSERT INTO payment_events (id, order_id, provider_payment_id, source, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), orderId || null, paymentId || null, source, event, detail ? String(detail).slice(0, 1000) : null, Date.now()],
    });
  } catch (err) {
    console.error('[ORDERS] Kon event niet loggen:', err.message);
  }
}

// items: [{ productId, name, version, quantity, unitCents, finalCents }]
async function insertOrder({ guildId, discordId, username, provider, status, items, subtotalCents, discountCode, discountCents, totalCents, currency }) {
  const now = Date.now();
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 6; attempt++) {
    const orderNumber = generateOrderNumber();
    try {
      await db.execute({
        sql: `INSERT INTO orders
              (id, order_number, guild_id, discord_id, discord_username, status, provider, subtotal_cents, discount_code, discount_cents, total_cents, currency, items, created_at, updated_at, paid_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id, orderNumber, guildId, discordId, username || null, status, provider,
          subtotalCents, discountCode || null, discountCents, totalCents, currency,
          JSON.stringify(items), now, now, status === 'paid' ? now : null,
        ],
      });
      return { id, orderNumber };
    } catch (err) {
      if (!/unique/i.test(err.message)) throw err; // alleen bij een dubbel order-nummer opnieuw proberen
    }
  }
  throw new Error('Kon geen uniek order-ID aanmaken');
}

async function getOrderBy(column, value) {
  const r = await db.execute({ sql: `SELECT * FROM orders WHERE ${column} = ?`, args: [value] });
  return r.rows[0] || null;
}
const getOrderByNumber = (n) => getOrderBy('order_number', n);
const getOrderById = (id) => getOrderBy('id', id);
const getOrderByPaymentId = (id) => getOrderBy('provider_payment_id', id);

function parseItems(order) {
  try {
    const parsed = JSON.parse(order.items);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Wat de browser/dashboard van een bestelling te zien krijgt (geen interne velden).
function serializeOrder(order, { admin = false } = {}) {
  const out = {
    orderNumber: order.order_number,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    items: parseItems(order).map((i) => ({
      productId: i.productId,
      name: i.name,
      version: i.version || null,
      quantity: i.quantity || 1,
      unitCents: i.unitCents,
      finalCents: i.finalCents,
    })),
    subtotalCents: Number(order.subtotal_cents),
    discountCode: order.discount_code || null,
    discountCents: Number(order.discount_cents || 0),
    totalCents: Number(order.total_cents),
    currency: order.currency,
    method: order.provider_method || null,
    createdAt: Number(order.created_at),
    paidAt: order.paid_at ? Number(order.paid_at) : null,
    // Alleen zinvol zolang er nog betaald kan worden.
    resumeUrl: order.status === 'pending' && order.checkout_url ? order.checkout_url : null,
  };
  if (admin) {
    Object.assign(out, {
      id: order.id,
      guildId: order.guild_id,
      discordId: order.discord_id,
      discordUsername: order.discord_username || null,
      provider: order.provider,
      providerPaymentId: order.provider_payment_id || null,
      providerStatus: order.provider_status || null,
      note: order.note || null,
      updatedAt: Number(order.updated_at),
    });
  }
  return out;
}

// Levering van een betaalde bestelling. Wordt alleen aangeroepen door de ene aanroep die de
// status van niet-betaald naar betaald heeft gezet (zie applyProviderPayment).
async function fulfillPaidOrder(order) {
  const items = parseItems(order);
  const now = Date.now();

  await db.execute({
    sql: `UPDATE purchases SET status = 'completed', purchased_at = ? WHERE order_id = ? AND status != 'completed'`,
    args: [now, order.id],
  });

  if (order.discount_code && Number(order.discount_cents) > 0) {
    await db.execute({
      sql: 'UPDATE discount_codes SET used_count = used_count + 1 WHERE guild_id = ? AND code = ?',
      args: [order.guild_id, order.discount_code],
    });
  }

  const fileIds = await filterProductsWithFile(items.map((i) => i.productId));
  const shopOrigin = require('../config').shopOrigin;
  const reviewLine = shopOrigin
    ? `\n\n⭐ Tevreden? Laat een review achter via [Mijn aankopen](${shopOrigin}/?guild=${order.guild_id}#/account).`
    : '';
  const names = items.map((i) => (i.version ? `${i.name} (v${i.version})` : i.name));

  await queuePendingDm(
    order.discord_id,
    'Bestelbevestiging',
    `Bedankt voor je bestelling **${order.order_number}**. Je betaling van ${formatPrice(Number(order.total_cents), order.currency)} is ontvangen.\n\n**Producten**\n${names.map((n) => `• ${n}`).join('\n')}\n\nJe bestand${fileIds.length === 1 ? '' : 'en'} ${fileIds.length === 1 ? 'volgt' : 'volgen'} direct hieronder in dit gesprek.${reviewLine}`,
    fileIds
  );
}

// Verwerkt de actuele toestand van een Mollie-betaling (door ONS opgehaald, zie mollie.getPayment).
// Idempotent en veilig bij gelijktijdige aanroepen. Geeft de nieuwe orderstatus terug.
async function applyProviderPayment(order, payment, source) {
  const mapped = mollie.mapStatus(payment.status);
  const method = payment.method || null;
  const now = Date.now();

  await db.execute({
    sql: `UPDATE orders SET provider_status = ?, provider_method = COALESCE(?, provider_method), updated_at = ? WHERE id = ?`,
    args: [payment.status, method, now, order.id],
  });

  if (mapped === 'paid') {
    const expectedValue = mollie.formatAmount(Number(order.total_cents));
    const paidValue = payment.amount && payment.amount.value;
    const paidCurrency = payment.amount && payment.amount.currency;
    if (paidValue !== expectedValue || String(paidCurrency).toUpperCase() !== String(order.currency).toUpperCase()) {
      await logEvent(order.id, payment.id, source, 'amount_mismatch', `verwacht ${expectedValue} ${order.currency}, betaald ${paidValue} ${paidCurrency}`);
      await db.execute({
        sql: `UPDATE orders SET note = ?, updated_at = ? WHERE id = ?`,
        args: [`Betaald bedrag (${paidValue} ${paidCurrency}) wijkt af van de bestelling (${expectedValue}). Niet geleverd — controleer dit in Mollie.`, now, order.id],
      });
      console.error(`[ORDERS] Bedrag klopt niet voor ${order.order_number}: verwacht ${expectedValue}, betaald ${paidValue} ${paidCurrency}.`);
      return order.status;
    }

    // Eén aanroep "wint" de overgang naar betaald; alleen die levert.
    const claim = await db.execute({
      sql: `UPDATE orders SET status = 'paid', paid_at = ?, note = NULL, updated_at = ? WHERE id = ? AND status != 'paid'`,
      args: [now, now, order.id],
    });
    if (claim.rowsAffected === 0) return 'paid'; // al verwerkt

    try {
      await fulfillPaidOrder(order);
    } catch (err) {
      // Levering mislukt: terugzetten zodat de volgende webhook/status-check het opnieuw probeert.
      await db.execute({ sql: `UPDATE orders SET status = 'pending', paid_at = NULL, updated_at = ? WHERE id = ? AND status = 'paid'`, args: [Date.now(), order.id] });
      await logEvent(order.id, payment.id, source, 'fulfillment_error', err.message);
      throw err;
    }
    await logEvent(order.id, payment.id, source, 'paid', method ? `methode: ${method}` : null);
    return 'paid';
  }

  if (mapped === 'failed' || mapped === 'canceled') {
    const moved = await db.execute({
      sql: `UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      args: [mapped, now, order.id],
    });
    if (moved.rowsAffected > 0) {
      await db.execute({ sql: `UPDATE purchases SET status = ? WHERE order_id = ? AND status = 'pending'`, args: [mapped, order.id] });
      await logEvent(order.id, payment.id, source, mapped, `Mollie-status: ${payment.status}`);
    }
    return moved.rowsAffected > 0 ? mapped : order.status;
  }

  await logEvent(order.id, payment.id, source, 'pending', `Mollie-status: ${payment.status}`);
  return order.status;
}

// Haalt de betaling bij Mollie op en verwerkt hem. Geeft de ververste orderrij terug.
async function syncOrder(order, source = 'sync') {
  if (!order || order.provider !== 'mollie' || !order.provider_payment_id) return order;
  const payment = await mollie.getPayment(order.provider_payment_id);
  await applyProviderPayment(order, payment, source);
  return getOrderById(order.id);
}

// Vangnet voor gemiste webhooks (server was even offline, Mollie kon ons niet bereiken, lokaal
// zonder https): controleert openstaande bestellingen op de achtergrond.
function startReconciler() {
  if (!mollie.isConfigured()) return;
  const INTERVAL_MS = 10 * 60 * 1000;

  const run = async () => {
    try {
      const now = Date.now();
      const open = await db.execute({
        sql: `SELECT * FROM orders WHERE status = 'pending' AND provider = 'mollie' AND provider_payment_id IS NOT NULL
              AND created_at < ? AND created_at > ? ORDER BY created_at ASC LIMIT 25`,
        args: [now - 5 * 60 * 1000, now - 7 * 24 * 60 * 60 * 1000],
      });
      for (const order of open.rows) {
        try {
          await syncOrder(order, 'reconciler');
        } catch (err) {
          console.warn(`[ORDERS] Controle van ${order.order_number} mislukt: ${err.message}`);
        }
      }

      // Bestelling zonder betaling bij de provider (crash tijdens aanmaken): afsluiten.
      const orphans = await db.execute({
        sql: `UPDATE orders SET status = 'failed', note = 'Betaling is nooit aangemaakt bij de provider.', updated_at = ?
              WHERE status = 'pending' AND provider = 'mollie' AND provider_payment_id IS NULL AND created_at < ?`,
        args: [now, now - 15 * 60 * 1000],
      });
      if (orphans.rowsAffected > 0) {
        await db.execute({
          sql: `UPDATE purchases SET status = 'failed' WHERE status = 'pending' AND order_id IN (SELECT id FROM orders WHERE status = 'failed' AND provider_payment_id IS NULL)`,
          args: [],
        });
      }
    } catch (err) {
      console.error('[ORDERS] Reconciler-fout:', err.message);
    }
  };

  setInterval(run, INTERVAL_MS).unref();
  console.log(`[ORDERS] Betaalcontrole actief: elke ${INTERVAL_MS / 60000} minuten openstaande bestellingen nalopen.`);
}

module.exports = {
  STATUS_LABELS,
  insertOrder,
  logEvent,
  getOrderByNumber,
  getOrderById,
  getOrderByPaymentId,
  parseItems,
  serializeOrder,
  applyProviderPayment,
  syncOrder,
  startReconciler,
};
