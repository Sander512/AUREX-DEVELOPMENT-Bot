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

async function hasCompletedPurchase(productId, discordId) {
  const result = await db.execute({
    sql: `SELECT 1 FROM purchases WHERE product_id = ? AND discord_id = ? AND status = 'completed' LIMIT 1`,
    args: [productId, discordId],
  });
  return result.rows.length > 0;
}

// Queues a DM for the bot to send on its next poll (see bot/utils/dmQueue.js).
// The API has no Discord connection of its own — this is the hand-off point.
async function queuePendingDm(discordId, embedTitle, embedDescription) {
  await db.execute({
    sql: `INSERT INTO pending_dms (id, discord_id, embed_title, embed_description, status, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)`,
    args: [crypto.randomUUID(), discordId, embedTitle, String(embedDescription).slice(0, 3800), Date.now()],
  });
}

function formatPrice(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
}

module.exports = {
  getProductRow,
  getPurchaseByStripeSessionId,
  hasCompletedPurchase,
  queuePendingDm,
  formatPrice,
};
