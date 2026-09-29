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
const {
  getProductRow,
  hasCompletedPurchase,
  queuePendingDm,
  filterProductsWithFile,
  getProductFile,
  blobToBuffer,
  markProductChannelDirty,
} = require('../utils/storeHelpers');

const router = express.Router();

const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;

const MAX_PRICE_CENTS = 100_000_000; // €1.000.000 — ruim genoeg, voorkomt kromme invoer
const MIN_PAID_CENTS = 50; // Stripe weigert betalingen onder 50 cent; 0 = gratis product
// Discord staat voor bots in DM's ongeveer 10 MB per bericht toe; we houden marge.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
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

async function getProductWithFlag(id) {
  const r = await db.execute({
    sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file FROM products p WHERE p.id = ?`,
    args: [id],
  });
  return r.rows[0] || null;
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
    isFree: row.price_cents === 0,
    hasFile: !!row.has_file,
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
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file FROM products p WHERE p.guild_id = ? AND p.active = 1 ORDER BY p.created_at ASC`,
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

    const withFile = new Set(await filterProductsWithFile(products.map((p) => p.id)));
    const missing = products.find((p) => !withFile.has(p.id));
    if (missing) {
      return res.status(409).json({ error: `"${missing.name}" is tijdelijk niet beschikbaar (er is nog geen bestand aan gekoppeld).` });
    }

    if (new Set(products.map((p) => p.guild_id)).size > 1) {
      return res.status(400).json({ error: 'Je kunt niet producten van verschillende shops tegelijk afrekenen.' });
    }
    if (new Set(products.map((p) => p.currency)).size > 1) {
      return res.status(400).json({ error: 'Producten met verschillende valuta kun je niet in één bestelling afrekenen.' });
    }
    const guildId = products[0].guild_id;

    // Gratis producten (prijs 0) gaan niet langs Stripe: direct als afgerond
    // registreren en het bestand per DM laten versturen.
    const freeProducts = products.filter((p) => p.price_cents === 0);
    const paidProducts = products.filter((p) => p.price_cents > 0);

    let freeClaimed = 0;
    if (freeProducts.length > 0) {
      const freeOrderId = crypto.randomUUID();
      const now = Date.now();
      for (const product of freeProducts) {
        await db.execute({
          sql: `INSERT INTO purchases
                (id, product_id, guild_id, discord_id, discord_username, stripe_session_id, order_id, amount_cents, currency, status, created_at, purchased_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, 'completed', ?, ?)`,
          args: [crypto.randomUUID(), product.id, product.guild_id, req.user.discordId, req.user.username, freeOrderId, product.currency, now, now],
        });
      }
      await queuePendingDm(
        req.user.discordId,
        'Je download',
        `Bedankt voor je bestelling.\n\n**Producten**\n${freeProducts
          .map((p) => `• ${p.version ? `${p.name} (v${p.version})` : p.name}`)
          .join('\n')}\n\nJe bestand${freeProducts.length === 1 ? ' volgt' : 'en volgen'} direct hieronder in dit gesprek.`,
        freeProducts.map((p) => p.id)
      );
      freeClaimed = freeProducts.length;
    }

    if (paidProducts.length === 0) {
      return res.json({ free: true, claimed: freeClaimed });
    }
    products.length = 0;
    products.push(...paidProducts);

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

    res.json({ url: session.url, claimed: freeClaimed });
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

// GET /store/my-orders/:guildId — volledige aankoopgeschiedenis van de
// ingelogde gebruiker (voor het "Mijn aankopen"-scherm), inclusief
// producten die ondertussen offline/verwijderd zijn — die blijven
// gewoon downloadbaar voor wie ze gekocht heeft.
router.get(
  '/my-orders/:guildId',
  requireSession,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: `SELECT
              pu.product_id AS id,
              pu.amount_cents AS paidCents,
              pu.currency AS currency,
              pu.purchased_at AS purchasedAt,
              p.name AS name,
              p.version AS version,
              p.image_urls AS image_urls,
              p.active AS productActive,
              (SELECT 1 FROM product_files f WHERE f.product_id = pu.product_id) AS hasFile
            FROM purchases pu
            LEFT JOIN products p ON p.id = pu.product_id
            WHERE pu.guild_id = ? AND pu.discord_id = ? AND pu.status = 'completed'
            ORDER BY pu.purchased_at DESC`,
      args: [guildId, req.user.discordId],
    });

    res.json({
      orders: result.rows.map((r) => ({
        id: r.id,
        name: r.name || 'Verwijderd product',
        version: r.version || null,
        imageUrl: parseJsonArray(r.image_urls)[0] || null,
        paidCents: r.paidCents,
        currency: r.currency,
        purchasedAt: r.purchasedAt,
        hasFile: !!r.hasFile,
        stillListed: !!r.productActive,
      })),
    });
  })
);

// ---------------------------------------------------------------------
// Admin (dashboard) — product-beheer, guild-scoped net als alle andere
// config-routes: X-API-Key (bot) OF een sessie met "Manage Server" op
// die guild.
// ---------------------------------------------------------------------

// POST /store/admin/product-file/:id  { guildId, fileName, mimeType, dataBase64 }
// Koppelt (of vervangt) het bestand dat kopers ontvangen. De body-limiet
// voor dit pad staat in server.js op 16 MB.
router.post(
  '/admin/product-file/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId, fileName, mimeType, dataBase64 } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const product = await getProductRow(id);
    if (!product || product.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 200) {
      return res.status(400).json({ error: 'fileName is verplicht (max 200 tekens)' });
    }
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return res.status(400).json({ error: 'Er is geen bestand meegestuurd.' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'Het bestand is leeg.' });
    if (buffer.length > MAX_FILE_BYTES) {
      return res.status(413).json({ error: `Bestand is te groot (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` });
    }

    // Bestandsnaam opschonen: geen paden of vreemde tekens.
    const safeName = fileName.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 200);

    await db.execute({
      sql: `INSERT INTO product_files (product_id, file_name, mime_type, size_bytes, data, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id) DO UPDATE SET
              file_name = excluded.file_name, mime_type = excluded.mime_type,
              size_bytes = excluded.size_bytes, data = excluded.data, updated_at = excluded.updated_at`,
      args: [id, safeName, typeof mimeType === 'string' ? mimeType.slice(0, 100) : null, buffer.length, buffer, Date.now()],
    });

    res.json({ success: true, fileName: safeName, sizeBytes: buffer.length });
  })
);

// GET /store/download/:productId — ingelogde koper haalt zijn gekochte
// bestand zelf op (vangnet voor als DM's van de bot uitstaan).
router.get(
  '/download/:productId',
  requireSession,
  asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const product = await getProductRow(productId);
    if (!product) return res.status(404).json({ error: 'Product niet gevonden' });
    if (!(await hasCompletedPurchase(productId, req.user.discordId))) {
      return res.status(403).json({ error: 'Je hebt dit product niet gekocht.' });
    }
    const file = await getProductFile(productId);
    if (!file) return res.status(404).json({ error: 'Er is geen bestand gekoppeld aan dit product.' });

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(file.file_name).replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(blobToBuffer(file.data));
  })
);

// GET /store/admin/products/:guildId — ook inactieve producten, voor het dashboard.
router.get(
  '/admin/products/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const result = await db.execute({
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file FROM products p WHERE p.guild_id = ? ORDER BY p.created_at ASC`,
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
    if (!isPositiveInteger(priceCents, MAX_PRICE_CENTS)) {
      return 'priceCents moet een geheel getal zijn (prijs in centen, bv. 1999 voor €19,99; 0 = gratis)';
    }
    if (priceCents > 0 && priceCents < MIN_PAID_CENTS) {
      return 'De laagste prijs voor een betaald product is 0,50 (betaalprovider-minimum). Gebruik 0 voor een gratis product.';
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

    await markProductChannelDirty(guildId);
    const row = await getProductWithFlag(id);
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

    await markProductChannelDirty(guildId);
    const row = await getProductWithFlag(id);
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

    await db.execute({ sql: 'DELETE FROM product_files WHERE product_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [id] });
    await markProductChannelDirty(guildId);
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

    const title = `Update voor ${product.name}`;
    const versionLine = product.version ? `**Nieuwe versie:** ${product.version}\n\n` : '';
    const changelogLine = product.changelog ? product.changelog : 'Geen changelog opgegeven.';
    const description = `${versionLine}${changelogLine}`;

    const fileIds = await filterProductsWithFile([id]);
    for (const row of buyers.rows) {
      await queuePendingDm(row.discord_id, title, description, fileIds);
    }

    res.json({ queued: buyers.rows.length });
  })
);

// ---------------------------------------------------------------------
// Bot-only — het "webshop-overzicht"-kanaal (/product kanaal)
// ---------------------------------------------------------------------

// POST /store/admin/product-channel  { guildId, channelId }
router.post(
  '/admin/product-channel',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId, channelId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    if (typeof channelId !== 'string' || !channelId) return res.status(400).json({ error: 'channelId is verplicht' });

    // Nieuw kanaal → oud bericht is niet meer relevant, de bot post een nieuwe.
    await db.execute({
      sql: `INSERT INTO product_channel_config (guild_id, channel_id, message_id, dirty, updated_at)
            VALUES (?, ?, NULL, 1, ?)
            ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = NULL, dirty = 1, updated_at = excluded.updated_at`,
      args: [guildId, channelId, Date.now()],
    });

    res.json({ success: true });
  })
);

// GET /store/admin/product-channel/:guildId — huidige instelling (voor meteen verversen na instellen).
router.get(
  '/admin/product-channel/:guildId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    const r = await db.execute({ sql: 'SELECT * FROM product_channel_config WHERE guild_id = ?', args: [guildId] });
    const row = r.rows[0];
    res.json({ config: row ? { guildId, channelId: row.channel_id, messageId: row.message_id } : null });
  })
);

// GET /store/product-channel-configs — alle kanalen die (mogelijk) een update nodig hebben.
// De bot pollt dit periodiek leeg, net als pending-dms.
router.get(
  '/product-channel-configs',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const r = await db.execute({ sql: 'SELECT * FROM product_channel_config WHERE dirty = 1' });
    res.json({
      configs: r.rows.map((row) => ({ guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id })),
    });
  })
);

// POST /store/product-channel/ack  { guildId, messageId }
// De bot meldt hiermee: bericht in dat kanaal staat weer up-to-date.
router.post(
  '/product-channel/ack',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { guildId, messageId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    await db.execute({
      sql: `UPDATE product_channel_config SET message_id = COALESCE(?, message_id), dirty = 0 WHERE guild_id = ?`,
      args: [typeof messageId === 'string' ? messageId : null, guildId],
    });

    res.json({ success: true });
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
        fileProductIds: parseJsonArray(r.file_product_ids),
      })),
    });
  })
);

// GET /store/product-file/:productId — bot haalt het bestand op om mee te sturen in de DM.
router.get(
  '/product-file/:productId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const file = await getProductFile(req.params.productId);
    if (!file) return res.status(404).json({ error: 'Geen bestand voor dit product' });
    res.json({
      fileName: file.file_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      dataBase64: blobToBuffer(file.data).toString('base64'),
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
