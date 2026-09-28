// api/utils/storeHelpers.js
// Shared between api/routes/store.js and api/routes/storeWebhook.js so
// both can read/write products, purchases and the DM-queue the same way.

const crypto = require('crypto');
const { db } = require('../database');

async function getProductRow(id) {
  const result = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

async function getPurchaseByStripeSessionId(sessionId) {
  const result = await db.execute({ sql: 'SELECT * FROM purchases WHERE stripe_session_id = ?', args: [sessionId] });
  return result.rows[0] || null;
}

async function getPurchasesByOrderId(orderId) {
  const result = await db.execute({ sql: 'SELECT * FROM purchases WHERE order_id = ?', args: [orderId] });
  return result.rows;
}

async function hasCompletedPurchase(productId, discordId) {
  const result = await db.execute({
    sql: `SELECT 1 FROM purchases WHERE product_id = ? AND discord_id = ? AND status = 'completed' LIMIT 1`,
    args: [productId, discordId],
  });
  return result.rows.length > 0;
}

// Queues a DM for the bot to send on its next poll (see bot/utils/dmQueue.js).
// The API has no Discord connection of its own — this is the hand-off point.
async function queuePendingDm(discordId, embedTitle, embedDescription, fileProductIds = []) {
  await db.execute({
    sql: `INSERT INTO pending_dms (id, discord_id, embed_title, embed_description, status, created_at, file_product_ids)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      crypto.randomUUID(),
      discordId,
      embedTitle,
      String(embedDescription).slice(0, 3800),
      Date.now(),
      fileProductIds.length ? JSON.stringify(fileProductIds) : null,
    ],
  });
}

// Geeft alleen de product-id's terug waarvoor daadwerkelijk een bestand is opgeslagen.
async function filterProductsWithFile(productIds) {
  const out = [];
  for (const id of productIds) {
    const r = await db.execute({ sql: 'SELECT 1 FROM product_files WHERE product_id = ?', args: [id] });
    if (r.rows.length) out.push(id);
  }
  return out;
}

async function getProductFile(productId) {
  const r = await db.execute({ sql: 'SELECT * FROM product_files WHERE product_id = ?', args: [productId] });
  return r.rows[0] || null;
}

// libsql geeft BLOB's terug als ArrayBuffer/Uint8Array — altijd naar Buffer.
function blobToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function formatPrice(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
}

module.exports = {
  getProductRow,
  getPurchaseByStripeSessionId,
  getPurchasesByOrderId,
  hasCompletedPurchase,
  queuePendingDm,
  filterProductsWithFile,
  getProductFile,
  blobToBuffer,
  formatPrice,
};
