// api/routes/store.js
// Webshop: producten, Stripe Checkout, aankoopgeschiedenis, admin-beheer
// en de "Stuur update"-DM aan iedereen die een product heeft gekocht.
//
// Belangrijk architectuurpunt: de API heeft zelf GEEN Discord-verbinding
// (dat heeft alleen het bot-proces). Dus in plaats van dat deze route de
// bot rechtstreeks aanroept, zet hij DM's klaar in de `pending_dms` tabel;
// de bot pollt die leeg (zie bot/utils/dmQueue.js). Zelfde patroon als de
// rest van deze app: de bot praat met de API, nooit andersom — dat blijft
// ook werken als bot en API ooit als aparte services draaien.

const crypto = require('crypto');
const express = require('express');
const { db } = require('../database');
const config = require('../config');
const { isDiscordId, isPositiveInteger } = require('../utils/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireApiKey, requireApiKeyOrGuildAccess, requireSession } = require('../middleware/auth');
const { getProductRow, hasCompletedPurchase, queuePendingDm } = require('../utils/storeHelpers');

const router = express.Router();

const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;

const MAX_PRICE_CENTS = 100_000_000; // €1.000.000 — ruim genoeg, voorkomt kromme invoer
const ALLOWED_CURRENCIES = new Set(['eur', 'usd', 'gbp']);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToPublicProduct(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    description: row.description || '',
    priceCents: row.price_cents,
    currency: row.currency,
    version: row.version || null,
    changelog: row.changelog || '',
    category: row.category || null,
    imageUrls: parseJsonArray(row.image_urls),
  };
}

function rowToAdminProduct(row) {
  return {
    ...rowToPublicProduct(row),
    changelog: row.changelog || '',
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------
// Publiek — productenlijst voor de webshop-pagina (geen login nodig)
// ---------------------------------------------------------------------

// GET /store/config — laat het dashboard weten waar de losse webshop
// draait (voor de "Shop-link" in het Webshop-tabblad).
router.get('/config', (req, res) => {
  res.json({
    shopUrl: config.shopOrigin || (config.publicUrl ? `${config.publicUrl}/shop` : null),
    guildId: config.shopGuildId,
    inviteUrl: config.discordInviteUrl,
  });
});

// GET /store/products/:guildId
router.get(
  '/products/:guildId',
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: 'SELECT * FROM products WHERE guild_id = ? AND active = 1 ORDER BY created_at ASC',
      args: [guildId],
    });

    res.json({ products: result.rows.map(rowToPublicProduct) });
  })
);

// ---------------------------------------------------------------------
// Ingelogde koper — checkout starten en eigen aankopen inzien
// ---------------------------------------------------------------------

// POST /store/checkout  { productIds: [...] }  (of { productId } voor één product)
// Winkelwagen: alle producten gaan in één Stripe Checkout Session.
router.post(
  '/checkout',
  requireSession,
  asyncHandler(async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is niet geconfigureerd (STRIPE_SECRET_KEY ontbreekt op de server).' });
    }

    const body = req.body || {};
    let ids = Array.isArray(body.productIds) ? body.productIds : body.productId ? [body.productId] : [];
    ids = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return res.status(400).json({ error: 'Je winkelwagen is leeg.' });
    if (ids.length > 20) return res.status(400).json({ error: 'Maximaal 20 producten per bestelling.' });

    const products = [];
    for (const id of ids) {
      const product = await getProductRow(id);
      if (!product || !product.active) return res.status(404).json({ error: 'Een product in je winkelwagen bestaat niet meer.' });
      if (await hasCompletedPurchase(product.id, req.user.discordId)) {
        return res.status(409).json({ error: `Je hebt "${product.name}" al gekocht.` });
      }
      products.push(product);
    }

    if (new Set(products.map((p) => p.guild_id)).size > 1) {
      return res.status(400).json({ error: 'Je kunt niet producten van verschillende shops tegelijk afrekenen.' });
    }
    if (new Set(products.map((p) => p.currency)).size > 1) {
      return res.status(400).json({ error: 'Producten met verschillende valuta kun je niet in één bestelling afrekenen.' });
    }
    const guildId = products[0].guild_id;

    if (!config.publicUrl) {
      return res.status(500).json({ error: 'PUBLIC_URL is niet ingesteld op de server — nodig om na afrekenen terug te sturen.' });
    }

    const orderId = crypto.randomUUID();
    const shopBase = config.shopOrigin || `${config.publicUrl}/shop`;
    const successUrl = `${shopBase}/?guild=${guildId}&success=1`;
    const cancelUrl = `${shopBase}/?guild=${guildId}&canceled=1`;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: products.map((product) => ({
          price_data: {
            currency: product.currency,
            product_data: {
              name: product.name,
              description: (product.description || '').slice(0, 500) || undefined,
            },
            unit_amount: product.price_cents,
          },
          quantity: 1,
        })),
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { orderId, guildId, discordId: req.user.discordId },
      });
    } catch (err) {
      return res.status(502).json({ error: `Stripe-fout: ${err.message}` });
    }

    // Eén rij per product; stripe_session_id is UNIQUE, dus die staat
    // alleen op de eerste rij — de webhook zoekt via order_id.
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      await db.execute({
        sql: `INSERT INTO purchases
              (id, product_id, guild_id, discord_id, discord_username, stripe_session_id, order_id, amount_cents, currency, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [
          crypto.randomUUID(),
          product.id,
          product.guild_id,
          req.user.discordId,
          req.user.username,
          i === 0 ? session.id : null,
          orderId,
          product.price_cents,
          product.currency,
          Date.now(),
        ],
      });
    }

    res.json({ url: session.url });
  })
);

// GET /store/my-purchases/:guildId — welke producten heeft de ingelogde
// gebruiker al gekocht in deze server (voor het "Al gekocht ✅" label).
router.get(
  '/my-purchases/:guildId',
  requireSession,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: `SELECT product_id FROM purchases WHERE guild_id = ? AND discord_id = ? AND status = 'completed'`,
      args: [guildId, req.user.discordId],
    });

    res.json({ productIds: result.rows.map((r) => r.product_id) });
  })
);

// ---------------------------------------------------------------------
// Admin (dashboard) — product-beheer, guild-scoped net als alle andere
// config-routes: X-API-Key (bot) OF een sessie met "Manage Server" op
// die guild.
// ---------------------------------------------------------------------

// GET /store/admin/products/:guildId — ook inactieve producten, voor het dashboard.
router.get(
  '/admin/products/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: 'SELECT * FROM products WHERE guild_id = ? ORDER BY created_at ASC',
      args: [guildId],
    });

    res.json({ products: result.rows.map(rowToAdminProduct) });
  })
);

function validateProductFields(fields, { partial }) {
  const { name, description, priceCents, currency, version, changelog, active, category, imageUrls } = fields;

  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      return 'name is verplicht (max 200 tekens)';
    }
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 4000) return 'description mag max 4000 tekens zijn';
  }
  if (!partial || priceCents !== undefined) {
    if (!isPositiveInteger(priceCents, MAX_PRICE_CENTS) || priceCents < 1) {
      return 'priceCents moet een positief geheel getal zijn (prijs in centen, bv. 1999 voor €19,99)';
    }
  }
  if (currency !== undefined) {
    if (typeof currency !== 'string' || !ALLOWED_CURRENCIES.has(currency.toLowerCase())) {
      return `currency moet één van deze zijn: ${[...ALLOWED_CURRENCIES].join(', ')}`;
    }
  }
  if (version !== undefined && version !== null) {
    if (typeof version !== 'string' || version.length > 100) return 'version mag max 100 tekens zijn';
  }
  if (changelog !== undefined && changelog !== null) {
    if (typeof changelog !== 'string' || changelog.length > 4000) return 'changelog mag max 4000 tekens zijn';
  }
  if (active !== undefined && typeof active !== 'boolean') return 'active moet true/false zijn';
  if (category !== undefined && category !== null) {
    if (typeof category !== 'string' || category.length > 60) return 'category mag max 60 tekens zijn';
  }
  if (imageUrls !== undefined && imageUrls !== null) {
    const ok =
      Array.isArray(imageUrls) &&
      imageUrls.length <= 8 &&
      imageUrls.every((u) => typeof u === 'string' && u.length <= 500 && /^https?:\/\//i.test(u));
    if (!ok) return 'imageUrls moet een lijst zijn van maximaal 8 links die met http(s):// beginnen';
  }

  return null;
}

// POST /store/admin/products  { guildId, name, description, priceCents, currency, version, changelog }
router.post(
  '/admin/products',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const validationError = validateProductFields(fields, { partial: false });
    if (validationError) return res.status(400).json({ error: validationError });

    const id = crypto.randomUUID();
    const now = Date.now();

    await db.execute({
      sql: `INSERT INTO products
            (id, guild_id, name, description, price_cents, currency, version, changelog, category, image_urls, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      args: [
        id,
        guildId,
        fields.name.trim(),
        fields.description || null,
        fields.priceCents,
        (fields.currency || 'eur').toLowerCase(),
        fields.version || null,
        fields.changelog || null,
        (fields.category && fields.category.trim()) || null,
        fields.imageUrls && fields.imageUrls.length ? JSON.stringify(fields.imageUrls) : null,
        now,
        now,
      ],
    });

    const row = await getProductRow(id);
    res.status(201).json({ product: rowToAdminProduct(row) });
  })
);

// POST /store/admin/products/:id  { guildId, ...fieldsToUpdate }
// Wijzigt alleen velden, verstuurt NOOIT vanzelf een DM — dat gebeurt
// bewust alleen via de aparte /notify-actie hieronder, zodat een kleine
// tekstfix niet meteen iedereen een "nieuwe versie!"-DM oplevert.
router.post(
  '/admin/products/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const existing = await getProductRow(id);
    if (!existing || existing.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    const validationError = validateProductFields(fields, { partial: true });
    if (validationError) return res.status(400).json({ error: validationError });

    const columnMap = {
      name: 'name',
      description: 'description',
      priceCents: 'price_cents',
      currency: 'currency',
      version: 'version',
      changelog: 'changelog',
      active: 'active',
      category: 'category',
      imageUrls: 'image_urls',
    };

    const setClauses = [];
    const args = [];
    for (const [camelKey, column] of Object.entries(columnMap)) {
      if (!(camelKey in fields)) continue;
      let value = fields[camelKey];
      if (camelKey === 'name') value = value.trim();
      if (camelKey === 'currency') value = value.toLowerCase();
      if (camelKey === 'active') value = value ? 1 : 0;
      if (camelKey === 'category') value = (value && value.trim()) || null;
      if (camelKey === 'imageUrls') value = value && value.length ? JSON.stringify(value) : null;
      setClauses.push(`${column} = ?`);
      args.push(value);
    }

    if (setClauses.length === 0) return res.status(400).json({ error: 'Geen geldige velden om te updaten' });

    setClauses.push('updated_at = ?');
    args.push(Date.now());
    args.push(id);

    await db.execute({ sql: `UPDATE products SET ${setClauses.join(', ')} WHERE id = ?`, args });

    const row = await getProductRow(id);
    res.json({ product: rowToAdminProduct(row) });
  })
);

// DELETE /store/admin/products/:id  { guildId }
router.delete(
  '/admin/products/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const existing = await getProductRow(id);
    if (!existing || existing.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [id] });
    res.json({ success: true });
  })
);

// POST /store/admin/products/:id/notify  { guildId }
// De "Stuur update"-knop: zet voor iedereen die dit product ooit heeft
// afgerond gekocht een DM klaar met de huidige versie + changelog.
router.post(
  '/admin/products/:id/notify',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const product = await getProductRow(id);
    if (!product || product.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    const buyers = await db.execute({
      sql: `SELECT DISTINCT discord_id FROM purchases WHERE product_id = ? AND status = 'completed'`,
      args: [id],
    });

    if (buyers.rows.length === 0) {
      return res.json({ queued: 0, message: 'Nog niemand heeft dit product gekocht — er is niemand om te DM\'en.' });
    }

    const title = `🔔 Update voor ${product.name}`;
    const versionLine = product.version ? `**Nieuwe versie:** ${product.version}\n\n` : '';
    const changelogLine = product.changelog ? product.changelog : 'Geen changelog opgegeven.';
    const description = `${versionLine}${changelogLine}`;

    for (const row of buyers.rows) {
      await queuePendingDm(row.discord_id, title, description);
    }

    res.json({ queued: buyers.rows.length });
  })
);

// ---------------------------------------------------------------------
// Bot-only — DM-wachtrij leegtrekken (X-API-Key, geen sessie)
// ---------------------------------------------------------------------

// GET /store/pending-dms?limit=10
router.get(
  '/pending-dms',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const result = await db.execute({
      sql: `SELECT * FROM pending_dms WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      args: [limit],
    });

    res.json({
      dms: result.rows.map((r) => ({
        id: r.id,
        discordId: r.discord_id,
        embedTitle: r.embed_title,
        embedDescription: r.embed_description,
      })),
    });
  })
);

// POST /store/pending-dms/:id/status  { status: 'sent' | 'failed' }
router.post(
  '/pending-dms/:id/status',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['sent', 'failed'].includes(status)) return res.status(400).json({ error: "status moet 'sent' of 'failed' zijn" });

    await db.execute({
      sql: `UPDATE pending_dms SET status = ?, sent_at = ? WHERE id = ?`,
      args: [status, Date.now(), id],
    });

    res.json({ success: true });
  })
);

module.exports = router;
