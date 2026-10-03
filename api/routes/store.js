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
const { getSessionUser } = require('../utils/session');
const { priceCart, getActiveBundles, normalizeCode, parseIds } = require('../utils/pricing');
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
// Dit is de opslaglimiet (dashboard-upload en /product add/update via de
// bot). Let op: dit is NIET de limiet die geldt als de bot het bestand
// als DM-bijlage probeert te versturen — daar bepaalt Discord zelf een
// (veel lagere, ~10 MB) grens. Grotere bestanden worden gewoon opgeslagen
// en blijven via de "Download"-knop op de website beschikbaar; de bot
// wijkt dan automatisch uit naar alleen een linkje i.p.v. de bijlage
// (zie bot/utils/dmQueue.js).
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB
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

// Geüploade foto's: id's in volgorde (cover eerst), als komma-lijst uit één
// subquery zodat elke bestaande product-query er simpel bij kan.
const IMAGE_IDS_SQL = `(SELECT group_concat(id, ',') FROM (SELECT id FROM product_images WHERE product_id = p.id AND mime_type LIKE 'image/%' ORDER BY position ASC, created_at ASC)) AS image_ids`;
// Alle media (foto's én video's) in volgorde, als "id|i" of "id|v". image_ids blijft alleen foto's,
// zodat covers, Discord-embeds en bundels nooit per ongeluk een video als afbeelding krijgen.
const MEDIA_IDS_SQL = `(SELECT group_concat(id || '|' || kind, ',') FROM (SELECT id, CASE WHEN mime_type LIKE 'video/%' THEN 'v' ELSE 'i' END AS kind FROM product_images WHERE product_id = p.id ORDER BY position ASC, created_at ASC)) AS media_ids`;
// Gemiddelde review-score en aantal, ook als subquery zodat elke product-query ze kan meenemen.
const RATING_SQL = `(SELECT AVG(rating) FROM reviews WHERE product_id = p.id) AS rating_avg, (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) AS rating_count`;
const PRODUCT_EXTRA_SQL = `${IMAGE_IDS_SQL}, ${MEDIA_IDS_SQL}, ${RATING_SQL}`;
const MAX_IMAGES = 15; // foto's + video's samen
const MAX_VIDEOS = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per foto
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB per video
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024; // max grootte van één Range-antwoord

// Controleert de eerste bytes, zodat een hernoemd bestand niet als video wordt opgeslagen.
function looksLikeVideo(buffer, mimeType) {
  if (mimeType === 'video/mp4') return buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
  if (mimeType === 'video/webm') return buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  return false;
}

// Regel onderaan bestel-DM's: nodigt kopers uit om een review te schrijven.
function reviewNudge(guildId) {
  const base = config.shopOrigin;
  if (!base) return '';
  return `\n\n⭐ Tevreden? Laat een review achter via [Mijn aankopen](${base}/?guild=${guildId}#/account).`;
}

function uploadedImages(row) {
  const ids = row && row.image_ids ? String(row.image_ids).split(',').filter(Boolean) : [];
  const base = config.publicUrl ? String(config.publicUrl).replace(/\/$/, '') : '';
  return ids.map((imageId) => ({ id: imageId, url: `${base}/store/product-image/${row.id}/${imageId}` }));
}

// Foto's én video's in galerij-volgorde: [{ id, type: 'image'|'video', url }].
function uploadedMedia(row) {
  const entries = row && row.media_ids ? String(row.media_ids).split(',').filter(Boolean) : [];
  const base = config.publicUrl ? String(config.publicUrl).replace(/\/$/, '') : '';
  return entries.map((entry) => {
    const [mediaId, kind] = entry.split('|');
    return { id: mediaId, type: kind === 'v' ? 'video' : 'image', url: `${base}/store/product-image/${row.id}/${mediaId}` };
  });
}

// Wat de webshop-galerij laat zien: geüploade media, daarna eventuele oude losse foto-links.
function galleryMedia(row) {
  if (row.media_ids === undefined) return allImageUrls(row).map((url) => ({ type: 'image', url }));
  return [...uploadedMedia(row).map((m) => ({ type: m.type, url: m.url })), ...parseJsonArray(row.image_urls).map((url) => ({ type: 'image', url }))];
}

// Alle foto's van een product: eerst de geüploade (eerste = cover), daarna
// eventuele oude losse links (van vóór foto-uploads bestonden).
function allImageUrls(row) {
  return [...uploadedImages(row).map((i) => i.url), ...parseJsonArray(row.image_urls)];
}

async function getProductWithFlag(id) {
  const r = await db.execute({
    sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file, ${PRODUCT_EXTRA_SQL} FROM products p WHERE p.id = ?`,
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
    imageUrls: allImageUrls(row),
    media: galleryMedia(row),
    createdAt: row.created_at,
    ratingAvg: row.rating_avg !== null && row.rating_avg !== undefined ? Math.round(Number(row.rating_avg) * 10) / 10 : null,
    ratingCount: Number(row.rating_count || 0),
    isBestseller: !!row.is_bestseller,
    isFree: row.price_cents === 0,
    hasFile: !!row.has_file,
  };
}

function rowToAdminProduct(row) {
  return {
    ...rowToPublicProduct(row),
    images: uploadedMedia(row),
    linkImageUrls: parseJsonArray(row.image_urls),
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
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file, ${PRODUCT_EXTRA_SQL} FROM products p WHERE p.guild_id = ? AND p.active = 1 ORDER BY p.created_at ASC`,
      args: [guildId],
    });

    // Bestseller = het actieve product met de meeste afgeronde aankopen (minstens 1).
    const top = await db.execute({
      sql: `SELECT pu.product_id AS id, COUNT(*) AS sales FROM purchases pu
            JOIN products p ON p.id = pu.product_id
            WHERE pu.guild_id = ? AND pu.status = 'completed' AND p.active = 1 AND p.price_cents > 0
            GROUP BY pu.product_id ORDER BY sales DESC, MIN(p.created_at) ASC LIMIT 1`,
      args: [guildId],
    });
    const bestId = top.rows[0] ? top.rows[0].id : null;

    res.json({ products: result.rows.map((row) => rowToPublicProduct({ ...row, is_bestseller: bestId !== null && row.id === bestId })) });
  })
);

// GET /store/top-seller/:guildId — het actieve product met de meeste
// afgeronde aankopen, voor de "bestseller"-uitlichting op de homepage.
// Geen verkopen (nieuwe shop)? Dan gewoon het nieuwste actieve product,
// zodat de homepage nooit leeg hoeft te zijn.
router.get(
  '/top-seller/:guildId',
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const bySales = await db.execute({
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file, ${PRODUCT_EXTRA_SQL}, COUNT(pu.id) AS sales
            FROM products p
            JOIN purchases pu ON pu.product_id = p.id AND pu.status = 'completed'
            WHERE p.guild_id = ? AND p.active = 1
            GROUP BY p.id
            ORDER BY sales DESC, p.created_at ASC
            LIMIT 1`,
      args: [guildId],
    });

    if (bySales.rows[0]) {
      const { sales, ...row } = bySales.rows[0];
      return res.json({ product: rowToPublicProduct(row), sales });
    }

    const newest = await db.execute({
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file, ${PRODUCT_EXTRA_SQL}
            FROM products p WHERE p.guild_id = ? AND p.active = 1
            ORDER BY p.created_at DESC LIMIT 1`,
      args: [guildId],
    });

    res.json({ product: newest.rows[0] ? rowToPublicProduct(newest.rows[0]) : null, sales: 0 });
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

    // Prijs inclusief bundelkorting en kortingscode: één bron van waarheid
    // (utils/pricing.js), dezelfde berekening als de "quote" in de winkelwagen.
    const pricing = await priceCart({ products, guildId, code: body.code, discordId: req.user.discordId });
    if (typeof body.code === 'string' && body.code.trim() && pricing.codeError) {
      return res.status(400).json({ error: pricing.codeError });
    }
    const priceOf = new Map(pricing.items.map((i) => [i.id, i]));
    const codeUsed = pricing.code && pricing.codeDiscountCents > 0 ? pricing.code.code : null;

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
          .join('\n')}\n\nJe bestand${freeProducts.length === 1 ? ' volgt' : 'en volgen'} direct hieronder in dit gesprek.${reviewNudge(guildId)}`,
        freeProducts.map((p) => p.id)
      );
      freeClaimed = freeProducts.length;
    }

    if (paidProducts.length === 0) {
      return res.json({ free: true, claimed: freeClaimed });
    }

    const paidTotal = paidProducts.reduce((sum, p) => sum + priceOf.get(p.id).finalCents, 0);
    const paidDiscount = paidProducts.reduce((sum, p) => {
      const i = priceOf.get(p.id);
      return sum + i.bundleDiscountCents + i.codeDiscountCents;
    }, 0);
    const discountFor = (p) => {
      const i = priceOf.get(p.id);
      return { cents: i.bundleDiscountCents + i.codeDiscountCents, code: i.codeDiscountCents > 0 ? codeUsed : null };
    };

    // 100% korting: er valt niets te betalen, dus ook niet langs Stripe — direct
    // afronden zoals een gratis product.
    if (paidTotal === 0) {
      const orderId = crypto.randomUUID();
      const now = Date.now();
      for (const product of paidProducts) {
        const d = discountFor(product);
        await db.execute({
          sql: `INSERT INTO purchases
                (id, product_id, guild_id, discord_id, discord_username, stripe_session_id, order_id, amount_cents, currency, status, created_at, purchased_at, discount_code, discount_cents)
                VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, 'completed', ?, ?, ?, ?)`,
          args: [crypto.randomUUID(), product.id, product.guild_id, req.user.discordId, req.user.username, orderId, product.currency, now, now, d.code, d.cents],
        });
      }
      if (codeUsed) {
        await db.execute({ sql: 'UPDATE discount_codes SET used_count = used_count + 1 WHERE guild_id = ? AND code = ?', args: [guildId, codeUsed] });
      }
      await queuePendingDm(
        req.user.discordId,
        'Je download',
        `Bedankt voor je bestelling.\n\n**Producten**\n${paidProducts
          .map((p) => `• ${p.version ? `${p.name} (v${p.version})` : p.name}`)
          .join('\n')}\n\nJe bestand${paidProducts.length === 1 ? ' volgt' : 'en volgen'} direct hieronder in dit gesprek.${reviewNudge(guildId)}`,
        paidProducts.map((p) => p.id)
      );
      return res.json({ free: true, claimed: freeClaimed + paidProducts.length });
    }
    if (paidTotal < MIN_PAID_CENTS) {
      return res.status(400).json({ error: 'Na korting is het totaalbedrag lager dan 0,50 (minimum van de betaalprovider). Haal een product uit je wagen of gebruik een andere code.' });
    }

    if (!config.publicUrl) {
      return res.status(500).json({ error: 'PUBLIC_URL is niet ingesteld op de server — nodig om na afrekenen terug te sturen.' });
    }

    const orderId = crypto.randomUUID();
    const shopBase = config.shopOrigin || `${config.publicUrl}/shop`;
    const successUrl = `${shopBase}/?guild=${guildId}&success=1`;
    const cancelUrl = `${shopBase}/?guild=${guildId}&canceled=1`;
    const currency = paidProducts[0].currency;

    // De korting gaat als Stripe-coupon mee (zichtbaar op de betaalpagina en
    // het bonnetje); de regels zelf blijven op volle prijs.
    let coupon = null;
    let session;
    try {
      if (paidDiscount > 0) {
        const label = codeUsed ? (pricing.bundleDiscountCents > 0 ? `Korting ${codeUsed} + bundel` : `Korting ${codeUsed}`) : 'Bundelkorting';
        coupon = await stripe.coupons.create({
          amount_off: paidDiscount,
          currency,
          duration: 'once',
          max_redemptions: 1,
          name: label.slice(0, 40),
        });
      }

      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: paidProducts.map((product) => ({
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
        ...(coupon ? { discounts: [{ coupon: coupon.id }] } : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { orderId, guildId, discordId: req.user.discordId, discountCode: codeUsed || '' },
      });
    } catch (err) {
      if (coupon) stripe.coupons.del(coupon.id).catch(() => {});
      return res.status(502).json({ error: `Stripe-fout: ${err.message}` });
    }

    // Eén rij per product; stripe_session_id is UNIQUE, dus die staat
    // alleen op de eerste rij — de webhook zoekt via order_id.
    // amount_cents = wat er voor dit product écht is betaald (na korting).
    for (let i = 0; i < paidProducts.length; i++) {
      const product = paidProducts[i];
      const d = discountFor(product);
      await db.execute({
        sql: `INSERT INTO purchases
              (id, product_id, guild_id, discord_id, discord_username, stripe_session_id, order_id, amount_cents, currency, status, created_at, discount_code, discount_cents)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          product.id,
          product.guild_id,
          req.user.discordId,
          req.user.username,
          i === 0 ? session.id : null,
          orderId,
          priceOf.get(product.id).finalCents,
          product.currency,
          Date.now(),
          d.code,
          d.cents,
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
              p.id AS id_for_images,
              ${IMAGE_IDS_SQL},
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
        imageUrl: allImageUrls({ id: r.id_for_images, image_ids: r.image_ids, image_urls: r.image_urls })[0] || null,
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

// GET /store/product-image/:productId/:imageId — publieke foto of video (de
// webshop laat hem cross-origin zien, dus CORP moet op cross-origin staan;
// helmet zet standaard same-origin, wat de media op Vercel zou blokkeren).
// Het id is een willekeurige UUID, dus de URL verandert zodra een bestand
// wordt vervangen — daarom mag hij "immutable" gecachet worden.
// Video's worden met HTTP Range in stukken geserveerd (nodig voor afspelen en
// spoelen, vooral in Safari) en per stuk uit de database gelezen, zodat een
// video van 50 MB nooit in één keer in het geheugen hoeft.
// Video's blijven in het geheugen (LRU), zodat elk Range-verzoek direct uit RAM
// komt in plaats van telkens een of twee roundtrips naar de database te kosten.
// Dat is wat het starten en spoelen van een video traag maakte.
const VIDEO_CACHE_MAX_BYTES = 150 * 1024 * 1024;
const VIDEO_ACTIVE_RECHECK_MS = 60 * 1000; // verwijderde video / gedeactiveerd product: binnen een minuut weg
const videoCache = new Map(); // imageId -> { productId, mime, buffer, checkedAt } (volgorde = LRU)
const videoLoading = new Map(); // imageId -> Promise (voorkomt dubbel laden)
let videoCacheBytes = 0;

function videoCacheEvict() {
  for (const [id, entry] of videoCache) {
    if (videoCacheBytes <= VIDEO_CACHE_MAX_BYTES) break;
    videoCache.delete(id);
    videoCacheBytes -= entry.buffer.length;
  }
}

async function getCachedVideo(productId, imageId) {
  let entry = videoCache.get(imageId);
  if (entry && entry.productId === productId) {
    if (Date.now() - entry.checkedAt > VIDEO_ACTIVE_RECHECK_MS) {
      const r = await db.execute({ sql: 'SELECT 1 FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.id = ? AND i.product_id = ? AND p.active = 1', args: [imageId, productId] });
      if (!r.rows[0]) {
        videoCache.delete(imageId);
        videoCacheBytes -= entry.buffer.length;
        return null;
      }
      entry.checkedAt = Date.now();
    }
    videoCache.delete(imageId); // naar het einde = recent gebruikt
    videoCache.set(imageId, entry);
    return entry;
  }

  if (!videoLoading.has(imageId)) {
    const load = (async () => {
      const r = await db.execute({
        sql: `SELECT i.mime_type, i.data FROM product_images i
              JOIN products p ON p.id = i.product_id
              WHERE i.id = ? AND i.product_id = ? AND p.active = 1 AND i.mime_type LIKE 'video/%'`,
        args: [imageId, productId],
      });
      const row = r.rows[0];
      if (!row) return null;
      const e = { productId, mime: row.mime_type, buffer: blobToBuffer(row.data), checkedAt: Date.now() };
      videoCache.set(imageId, e);
      videoCacheBytes += e.buffer.length;
      videoCacheEvict();
      return e;
    })().finally(() => videoLoading.delete(imageId));
    videoLoading.set(imageId, load);
  }
  return videoLoading.get(imageId);
}

function sendVideo(req, res, entry) {
  const { buffer, mime } = entry;
  const size = buffer.length;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');

  const header = req.headers.range;
  if (!header) {
    res.setHeader('Content-Length', size);
    return res.end(buffer);
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  let start;
  let end = size - 1;
  if (m[1] === '') {
    start = Math.max(size - Number(m[2]), 0); // "bytes=-500": de laatste 500 bytes
  } else {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    if (end - start + 1 > VIDEO_CHUNK_BYTES) end = start + VIDEO_CHUNK_BYTES - 1;
  }
  if (start >= size || start > end) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  const part = buffer.subarray(start, end + 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', part.length);
  return res.end(part);
}

router.get(
  '/product-image/:productId/:imageId',
  asyncHandler(async (req, res) => {
    const { productId, imageId } = req.params;

    // Video die al in het geheugen staat: geen database nodig.
    if (videoCache.has(imageId)) {
      const hit = await getCachedVideo(productId, imageId);
      if (hit) return sendVideo(req, res, hit);
      return res.status(404).json({ error: 'Bestand niet gevonden' });
    }

    const r = await db.execute({
      sql: `SELECT i.mime_type,
                   CASE WHEN i.mime_type LIKE 'video/%' THEN NULL ELSE i.data END AS data
            FROM product_images i
            JOIN products p ON p.id = i.product_id
            WHERE i.id = ? AND i.product_id = ? AND p.active = 1`,
      args: [imageId, productId],
    });
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Bestand niet gevonden' });

    if (String(row.mime_type).startsWith('video/')) {
      const entry = await getCachedVideo(productId, imageId);
      if (!entry) return res.status(404).json({ error: 'Bestand niet gevonden' });
      return sendVideo(req, res, entry);
    }

    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(blobToBuffer(row.data));
  })
);

// POST /store/admin/product-images/:id
//   { guildId, replace?: boolean, images: [{ fileName, mimeType, dataBase64 }] }
// ("images" mogen ook video's zijn: MP4 of WEBM, max 50 MB, max 3 per product.)
// Voegt foto's toe aan het einde (volgorde = volgorde van de lijst; de eerste
// foto van een product is de cover). Met replace=true worden eerst alle
// bestaande geüploade foto's van dit product verwijderd.
router.post(
  '/admin/product-images/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId, images, replace } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const product = await getProductRow(id);
    if (!product || product.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Er zijn geen foto\'s meegestuurd.' });
    }

    const prepared = [];
    for (const img of images) {
      const mimeType = img && typeof img.mimeType === 'string' ? img.mimeType.toLowerCase().split(';')[0].trim() : '';
      const isVideo = ALLOWED_VIDEO_TYPES.has(mimeType);
      if (!ALLOWED_IMAGE_TYPES.has(mimeType) && !isVideo) {
        return res.status(400).json({ error: 'Alleen PNG, JPG, WEBP, GIF of een MP4/WEBM-video zijn toegestaan.' });
      }
      if (typeof img.dataBase64 !== 'string' || img.dataBase64.length === 0) {
        return res.status(400).json({ error: 'Een van de foto\'s is leeg.' });
      }
      const buffer = Buffer.from(img.dataBase64, 'base64');
      if (buffer.length === 0) return res.status(400).json({ error: 'Een van de foto\'s is leeg.' });
      if (isVideo) {
        if (buffer.length > MAX_VIDEO_BYTES) {
          return res.status(413).json({ error: `Een video is te groot (max ${MAX_VIDEO_BYTES / 1024 / 1024} MB per video).` });
        }
        if (!looksLikeVideo(buffer, mimeType)) {
          return res.status(400).json({ error: 'Een van de bestanden is geen geldige MP4/WEBM-video.' });
        }
      } else if (buffer.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: `Een foto is te groot (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB per foto).` });
      }
      const fileName =
        typeof img.fileName === 'string' ? img.fileName.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 200) : null;
      prepared.push({ fileName, mimeType, buffer, isVideo });
    }

    const existing = replace
      ? 0
      : (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', args: [id] })).rows[0].n;
    if (Number(existing) + prepared.length > MAX_IMAGES) {
      return res.status(400).json({ error: `Een product mag maximaal ${MAX_IMAGES} foto's en video's hebben (er staan er al ${existing}).` });
    }

    const newVideos = prepared.filter((p) => p.isVideo).length;
    if (newVideos > 0) {
      const existingVideos = replace
        ? 0
        : Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM product_images WHERE product_id = ? AND mime_type LIKE 'video/%'", args: [id] })).rows[0].n);
      if (existingVideos + newVideos > MAX_VIDEOS) {
        return res.status(400).json({ error: `Een product mag maximaal ${MAX_VIDEOS} video's hebben (er staan er al ${existingVideos}).` });
      }
    }

    if (replace) await db.execute({ sql: 'DELETE FROM product_images WHERE product_id = ?', args: [id] });

    const startPos = replace
      ? 0
      : Number((await db.execute({ sql: 'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_images WHERE product_id = ?', args: [id] })).rows[0].p);

    const now = Date.now();
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      await db.execute({
        sql: `INSERT INTO product_images (id, product_id, position, file_name, mime_type, size_bytes, data, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [crypto.randomUUID(), id, startPos + i, p.fileName, p.mimeType, p.buffer.length, p.buffer, now + i],
      });
    }

    await db.execute({ sql: 'UPDATE products SET updated_at = ? WHERE id = ?', args: [now, id] });
    await markProductChannelDirty(guildId);
    const row = await getProductWithFlag(id);
    res.json({ product: rowToAdminProduct(row) });
  })
);

// POST /store/admin/product-images/:id/cover  { guildId, imageId }
// Zet een foto vooraan (= cover); de rest schuift op met behoud van volgorde.
router.post(
  '/admin/product-images/:id/cover',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId, imageId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const product = await getProductRow(id);
    if (!product || product.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    const all = await db.execute({
      sql: 'SELECT id FROM product_images WHERE product_id = ? ORDER BY position ASC, created_at ASC',
      args: [id],
    });
    const ids = all.rows.map((r) => r.id);
    if (!ids.includes(imageId)) return res.status(404).json({ error: 'Foto niet gevonden' });

    const ordered = [imageId, ...ids.filter((x) => x !== imageId)];
    for (let i = 0; i < ordered.length; i++) {
      await db.execute({ sql: 'UPDATE product_images SET position = ? WHERE id = ?', args: [i, ordered[i]] });
    }

    await db.execute({ sql: 'UPDATE products SET updated_at = ? WHERE id = ?', args: [Date.now(), id] });
    await markProductChannelDirty(guildId);
    const row = await getProductWithFlag(id);
    res.json({ product: rowToAdminProduct(row) });
  })
);

// DELETE /store/admin/product-images/:id/:imageId  { guildId }
router.delete(
  '/admin/product-images/:id/:imageId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id, imageId } = req.params;
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const product = await getProductRow(id);
    if (!product || product.guild_id !== guildId) return res.status(404).json({ error: 'Product niet gevonden' });

    await db.execute({ sql: 'DELETE FROM product_images WHERE id = ? AND product_id = ?', args: [imageId, id] });
    await db.execute({ sql: 'UPDATE products SET updated_at = ? WHERE id = ?', args: [Date.now(), id] });
    await markProductChannelDirty(guildId);
    const row = await getProductWithFlag(id);
    res.json({ product: rowToAdminProduct(row) });
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
      sql: `SELECT p.*, (SELECT 1 FROM product_files f WHERE f.product_id = p.id) AS has_file, ${PRODUCT_EXTRA_SQL} FROM products p WHERE p.guild_id = ? ORDER BY p.created_at ASC`,
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
    await db.execute({ sql: 'DELETE FROM product_images WHERE product_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM reviews WHERE product_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [id] });
    await markProductChannelDirty(guildId);
    res.json({ success: true });
  })
);

// POST /store/admin/products/:id/notify  { guildId, includeFile? }
// De "Stuur update"-knop: zet voor iedereen die dit product ooit heeft
// afgerond gekocht een DM klaar met de huidige versie + changelog.
router.post(
  '/admin/products/:id/notify',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { guildId, includeFile } = req.body || {};
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

    // includeFile=false: alleen de tekst (versie/changelog), zonder het bestand
    // opnieuw mee te sturen. Standaard (niet opgegeven) blijft het bestand mee.
    const fileIds = includeFile === false ? [] : await filterProductsWithFile([id]);
    for (const row of buyers.rows) {
      await queuePendingDm(row.discord_id, title, description, fileIds);
    }

    res.json({ queued: buyers.rows.length });
  })
);

// ---------------------------------------------------------------------
// Prijs-quote, bundels, reviews, kortingscodes
// ---------------------------------------------------------------------

// POST /store/quote  { guildId, productIds, code? } — publiek. Toont wat de
// winkelwagen na bundelkorting/kortingscode kost. Is de bezoeker ingelogd,
// dan wordt ook "code al eens gebruikt" meegenomen.
router.post(
  '/quote',
  asyncHandler(async (req, res) => {
    const { guildId, productIds, code } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    if (!Array.isArray(productIds) || productIds.length > 20) return res.status(400).json({ error: 'Ongeldige winkelwagen' });

    const products = [];
    for (const id of [...new Set(productIds.filter((x) => typeof x === 'string'))]) {
      const row = await getProductRow(id);
      if (row && row.active && row.guild_id === guildId) products.push(row);
    }
    const user = getSessionUser(req);
    const pricing = await priceCart({ products, guildId, code, discordId: user ? user.discordId : null });
    res.json({ pricing });
  })
);

// GET /store/bundles/:guildId — actieve bundels waarvan alle producten nog in de shop staan.
router.get(
  '/bundles/:guildId',
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const out = [];
    for (const b of await getActiveBundles(guildId)) {
      const items = [];
      for (const id of b.productIds) {
        const r = await db.execute({
          sql: `SELECT p.*, ${IMAGE_IDS_SQL} FROM products p WHERE p.id = ? AND p.guild_id = ? AND p.active = 1`,
          args: [id, guildId],
        });
        if (r.rows[0]) items.push(r.rows[0]);
      }
      if (items.length !== b.productIds.length || items.length < 2) continue;

      const original = items.reduce((s, p) => s + Number(p.price_cents), 0);
      const final = items.reduce((s, p) => s + Math.round((Number(p.price_cents) * (100 - b.discountPercent)) / 100), 0);
      out.push({
        id: b.id,
        name: b.name,
        description: b.description,
        discountPercent: b.discountPercent,
        currency: items[0].currency,
        originalCents: original,
        finalCents: final,
        products: items.map((p) => ({
          id: p.id,
          name: p.name,
          priceCents: Number(p.price_cents),
          imageUrl: allImageUrls(p)[0] || null,
        })),
      });
    }
    res.json({ bundles: out });
  })
);

// ---- Reviews ----

const MAX_REVIEW_CHARS = 1000;

function rowToReview(r) {
  return {
    id: r.id,
    productId: r.product_id,
    productName: r.product_name || null,
    productImage: r.cover_id ? `${config.publicUrl ? String(config.publicUrl).replace(/\/$/, '') : ''}/store/product-image/${r.product_id}/${r.cover_id}` : null,
    username: r.username || 'Koper',
    rating: Number(r.rating),
    body: r.body || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const REVIEW_SELECT = `SELECT r.*, p.name AS product_name,
  (SELECT id FROM product_images WHERE product_id = p.id AND mime_type LIKE 'image/%' ORDER BY position ASC, created_at ASC LIMIT 1) AS cover_id
  FROM reviews r JOIN products p ON p.id = r.product_id`;

// GET /store/reviews/:guildId?productId=&limit=&offset= — publiek.
router.get(
  '/reviews/:guildId',
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });

    const productId = typeof req.query.productId === 'string' && req.query.productId ? req.query.productId : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = `WHERE r.guild_id = ? AND p.active = 1${productId ? ' AND r.product_id = ?' : ''}`;
    const args = productId ? [guildId, productId] : [guildId];

    const list = await db.execute({
      sql: `${REVIEW_SELECT} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    });

    const dist = await db.execute({
      sql: `SELECT r.rating AS rating, COUNT(*) AS n FROM reviews r JOIN products p ON p.id = r.product_id ${where} GROUP BY r.rating`,
      args,
    });
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let total = 0;
    for (const row of dist.rows) {
      distribution[row.rating] = Number(row.n);
      count += Number(row.n);
      total += Number(row.rating) * Number(row.n);
    }

    res.json({
      reviews: list.rows.map(rowToReview),
      summary: { count, average: count ? Math.round((total / count) * 10) / 10 : null, distribution },
    });
  })
);

// GET /store/my-reviews/:guildId — mijn eigen reviews (om het formulier in te vullen).
router.get(
  '/my-reviews/:guildId',
  requireSession,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    const r = await db.execute({
      sql: 'SELECT product_id, rating, body, updated_at FROM reviews WHERE guild_id = ? AND discord_id = ?',
      args: [guildId, req.user.discordId],
    });
    const reviews = {};
    for (const row of r.rows) reviews[row.product_id] = { rating: Number(row.rating), body: row.body || '', updatedAt: row.updated_at };
    res.json({ reviews });
  })
);

// POST /store/reviews  { productId, rating, body? } — alleen kopers; opnieuw insturen werkt bij.
router.post(
  '/reviews',
  requireSession,
  asyncHandler(async (req, res) => {
    const { productId, rating, body } = req.body || {};
    if (typeof productId !== 'string' || !productId) return res.status(400).json({ error: 'productId is verplicht' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Geef een score van 1 tot 5 sterren.' });
    if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > MAX_REVIEW_CHARS)) {
      return res.status(400).json({ error: `Je review mag maximaal ${MAX_REVIEW_CHARS} tekens zijn.` });
    }

    const product = await getProductRow(productId);
    if (!product) return res.status(404).json({ error: 'Product niet gevonden' });
    if (!(await hasCompletedPurchase(productId, req.user.discordId))) {
      return res.status(403).json({ error: 'Alleen kopers van dit product kunnen een review schrijven.' });
    }

    const now = Date.now();
    const text = typeof body === 'string' ? body.trim() : '';
    await db.execute({
      sql: `INSERT INTO reviews (id, product_id, guild_id, discord_id, username, rating, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id, discord_id) DO UPDATE SET
              rating = excluded.rating, body = excluded.body, username = excluded.username, updated_at = excluded.updated_at`,
      args: [crypto.randomUUID(), productId, product.guild_id, req.user.discordId, req.user.username, rating, text || null, now, now],
    });
    await markProductChannelDirty(product.guild_id);

    res.json({ success: true, review: { productId, rating, body: text } });
  })
);

// DELETE /store/reviews/:productId — eigen review intrekken.
router.delete(
  '/reviews/:productId',
  requireSession,
  asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const product = await getProductRow(productId);
    await db.execute({ sql: 'DELETE FROM reviews WHERE product_id = ? AND discord_id = ?', args: [productId, req.user.discordId] });
    if (product) await markProductChannelDirty(product.guild_id);
    res.json({ success: true });
  })
);

// ---- Beheer: reviews (modereren) ----

// GET /store/admin/reviews/:guildId
router.get(
  '/admin/reviews/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    const r = await db.execute({
      sql: `${REVIEW_SELECT} WHERE r.guild_id = ? ORDER BY r.created_at DESC LIMIT 200`,
      args: [guildId],
    });
    res.json({ reviews: r.rows.map(rowToReview) });
  })
);

// DELETE /store/admin/reviews/:id  { guildId }
router.delete(
  '/admin/reviews/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    await db.execute({ sql: 'DELETE FROM reviews WHERE id = ? AND guild_id = ?', args: [req.params.id, guildId] });
    await markProductChannelDirty(guildId);
    res.json({ success: true });
  })
);

// ---- Beheer: bundels ----

function rowToAdminBundle(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    productIds: parseIds(row.product_ids),
    discountPercent: Number(row.discount_percent),
    active: !!row.active,
    createdAt: row.created_at,
  };
}

async function validateBundleFields(guildId, fields, { partial }) {
  const { name, description, productIds, discountPercent } = fields;
  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return 'name is verplicht (max 100 tekens)';
  }
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 500)) {
    return 'description mag max 500 tekens zijn';
  }
  if (!partial || discountPercent !== undefined) {
    if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 90) return 'Korting moet een geheel percentage zijn tussen 1 en 90';
  }
  if (!partial || productIds !== undefined) {
    if (!Array.isArray(productIds) || new Set(productIds).size !== productIds.length || productIds.length < 2 || productIds.length > 10) {
      return 'Kies 2 tot 10 verschillende producten voor een bundel';
    }
    for (const id of productIds) {
      const prod = typeof id === 'string' ? await getProductRow(id) : null;
      if (!prod || prod.guild_id !== guildId) return 'Een gekozen product bestaat niet';
      if (Number(prod.price_cents) === 0) return `"${prod.name}" is gratis — gratis producten kunnen niet in een bundel`;
    }
  }
  return null;
}

router.get(
  '/admin/bundles/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    const r = await db.execute({ sql: 'SELECT * FROM bundles WHERE guild_id = ? ORDER BY created_at DESC', args: [guildId] });
    res.json({ bundles: r.rows.map(rowToAdminBundle) });
  })
);

router.post(
  '/admin/bundles',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    const error = await validateBundleFields(guildId, fields, { partial: false });
    if (error) return res.status(400).json({ error });

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO bundles (id, guild_id, name, description, product_ids, discount_percent, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [id, guildId, fields.name.trim(), fields.description || null, JSON.stringify(fields.productIds), fields.discountPercent, Date.now()],
    });
    const r = await db.execute({ sql: 'SELECT * FROM bundles WHERE id = ?', args: [id] });
    res.status(201).json({ bundle: rowToAdminBundle(r.rows[0]) });
  })
);

router.post(
  '/admin/bundles/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, ...fields } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    const existing = (await db.execute({ sql: 'SELECT * FROM bundles WHERE id = ? AND guild_id = ?', args: [req.params.id, guildId] })).rows[0];
    if (!existing) return res.status(404).json({ error: 'Bundel niet gevonden' });
    if (fields.active !== undefined && typeof fields.active !== 'boolean') return res.status(400).json({ error: 'active moet true/false zijn' });
    const error = await validateBundleFields(guildId, fields, { partial: true });
    if (error) return res.status(400).json({ error });

    const sets = [];
    const args = [];
    const map = { name: 'name', description: 'description', discountPercent: 'discount_percent', active: 'active', productIds: 'product_ids' };
    for (const [key, col] of Object.entries(map)) {
      if (!(key in fields)) continue;
      let v = fields[key];
      if (key === 'name') v = v.trim();
      if (key === 'active') v = v ? 1 : 0;
      if (key === 'productIds') v = JSON.stringify(v);
      sets.push(`${col} = ?`);
      args.push(v);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Geen geldige velden om te updaten' });
    args.push(req.params.id);
    await db.execute({ sql: `UPDATE bundles SET ${sets.join(', ')} WHERE id = ?`, args });
    const r = await db.execute({ sql: 'SELECT * FROM bundles WHERE id = ?', args: [req.params.id] });
    res.json({ bundle: rowToAdminBundle(r.rows[0]) });
  })
);

router.delete(
  '/admin/bundles/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    await db.execute({ sql: 'DELETE FROM bundles WHERE id = ? AND guild_id = ?', args: [req.params.id, guildId] });
    res.json({ success: true });
  })
);

// ---- Beheer: kortingscodes ----

function rowToAdminCode(row) {
  return {
    id: row.id,
    code: row.code,
    percentOff: row.percent_off !== null && row.percent_off !== undefined ? Number(row.percent_off) : null,
    amountOffCents: row.amount_off_cents !== null && row.amount_off_cents !== undefined ? Number(row.amount_off_cents) : null,
    maxUses: row.max_uses !== null && row.max_uses !== undefined ? Number(row.max_uses) : null,
    usedCount: Number(row.used_count || 0),
    expiresAt: row.expires_at !== null && row.expires_at !== undefined ? Number(row.expires_at) : null,
    active: !!row.active,
    createdAt: row.created_at,
  };
}

router.get(
  '/admin/discount-codes/:guildId',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.params;
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    const r = await db.execute({ sql: 'SELECT * FROM discount_codes WHERE guild_id = ? ORDER BY created_at DESC', args: [guildId] });
    res.json({ codes: r.rows.map(rowToAdminCode) });
  })
);

router.post(
  '/admin/discount-codes',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, code, percentOff, amountOffCents, maxUses, expiresAt } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });

    const normalized = normalizeCode(code);
    if (!/^[A-Z0-9_-]{3,30}$/.test(normalized)) return res.status(400).json({ error: 'Code: 3-30 tekens, alleen letters, cijfers, - en _' });

    const hasPercent = percentOff !== undefined && percentOff !== null;
    const hasAmount = amountOffCents !== undefined && amountOffCents !== null;
    if (hasPercent === hasAmount) return res.status(400).json({ error: 'Kies óf een percentage óf een vast bedrag' });
    if (hasPercent && (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100)) {
      return res.status(400).json({ error: 'Percentage moet een geheel getal zijn tussen 1 en 100' });
    }
    if (hasAmount && !isPositiveInteger(amountOffCents, MAX_PRICE_CENTS)) {
      return res.status(400).json({ error: 'Bedrag moet een positief aantal centen zijn' });
    }
    if (hasAmount && amountOffCents === 0) return res.status(400).json({ error: 'Bedrag moet groter dan 0 zijn' });
    if (maxUses !== undefined && maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
      return res.status(400).json({ error: 'Maximaal aantal keer gebruiken moet 1 of hoger zijn' });
    }
    if (expiresAt !== undefined && expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt < Date.now())) {
      return res.status(400).json({ error: 'De verloopdatum moet in de toekomst liggen' });
    }

    const dupe = await db.execute({ sql: 'SELECT 1 FROM discount_codes WHERE guild_id = ? AND code = ?', args: [guildId, normalized] });
    if (dupe.rows.length) return res.status(409).json({ error: 'Deze code bestaat al' });

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO discount_codes (id, guild_id, code, percent_off, amount_off_cents, max_uses, used_count, expires_at, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`,
      args: [id, guildId, normalized, hasPercent ? percentOff : null, hasAmount ? amountOffCents : null, maxUses ?? null, expiresAt ?? null, Date.now()],
    });
    const r = await db.execute({ sql: 'SELECT * FROM discount_codes WHERE id = ?', args: [id] });
    res.status(201).json({ code: rowToAdminCode(r.rows[0]) });
  })
);

router.post(
  '/admin/discount-codes/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId, active } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active moet true/false zijn' });
    await db.execute({ sql: 'UPDATE discount_codes SET active = ? WHERE id = ? AND guild_id = ?', args: [active ? 1 : 0, req.params.id, guildId] });
    const r = await db.execute({ sql: 'SELECT * FROM discount_codes WHERE id = ? AND guild_id = ?', args: [req.params.id, guildId] });
    if (!r.rows[0]) return res.status(404).json({ error: 'Code niet gevonden' });
    res.json({ code: rowToAdminCode(r.rows[0]) });
  })
);

router.delete(
  '/admin/discount-codes/:id',
  requireApiKeyOrGuildAccess,
  asyncHandler(async (req, res) => {
    const { guildId } = req.body || {};
    if (!isDiscordId(guildId)) return res.status(400).json({ error: 'Invalid or missing guildId' });
    await db.execute({ sql: 'DELETE FROM discount_codes WHERE id = ? AND guild_id = ?', args: [req.params.id, guildId] });
    res.json({ success: true });
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

// GET /store/product-file-meta/:productId — alleen bestandsnaam/grootte,
// zonder de (mogelijk enorme) inhoud. De bot gebruikt dit om te bepalen of
// een bestand nog als DM-bijlage past, zonder eerst het hele bestand in
// het geheugen te moeten laden (bewust een aparte, lichte query die de
// BLOB-kolom niet aanraakt — niet getProductFile() hergebruiken).
router.get(
  '/product-file-meta/:productId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const r = await db.execute({
      sql: 'SELECT file_name, mime_type, size_bytes FROM product_files WHERE product_id = ?',
      args: [req.params.productId],
    });
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Geen bestand voor dit product' });
    res.json({ fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes });
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
