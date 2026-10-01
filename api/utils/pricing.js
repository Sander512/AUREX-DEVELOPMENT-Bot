// api/utils/pricing.js
// Eén plek waar de prijs van een winkelwagen wordt berekend, zodat de
// "quote" in de winkelwagen en het echte afrekenen ALTIJD hetzelfde bedrag
// geven. De server rekent; de browser toont alleen wat hier uitkomt.
//
// Volgorde:
//   1. Bundelkorting: zit élk product van een actieve bundel in de wagen,
//      dan krijgen die producten het bundelpercentage (bij overlap het hoogste).
//   2. Kortingscode: percentage of vast bedrag over wat er na stap 1 overblijft.
// Gratis producten (prijs 0) doen nergens aan mee.

const { db } = require('../database');

function normalizeCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase().slice(0, 40) : '';
}

function parseIds(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function getActiveBundles(guildId) {
  const r = await db.execute({
    sql: 'SELECT * FROM bundles WHERE guild_id = ? AND active = 1 ORDER BY created_at ASC',
    args: [guildId],
  });
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || '',
    productIds: parseIds(row.product_ids),
    discountPercent: Number(row.discount_percent),
  }));
}

// Zoekt en valideert een code. Geeft { code } of { error }.
async function lookupCode(guildId, rawCode, discordId) {
  const code = normalizeCode(rawCode);
  if (!code) return { error: null, code: null };

  const r = await db.execute({
    sql: 'SELECT * FROM discount_codes WHERE guild_id = ? AND code = ?',
    args: [guildId, code],
  });
  const row = r.rows[0];
  if (!row || !row.active) return { error: 'Deze kortingscode bestaat niet of is niet meer geldig.' };
  if (row.expires_at && Number(row.expires_at) < Date.now()) return { error: 'Deze kortingscode is verlopen.' };
  if (row.max_uses !== null && row.max_uses !== undefined && Number(row.used_count) >= Number(row.max_uses)) {
    return { error: 'Deze kortingscode is op (maximaal aantal keer gebruikt).' };
  }

  if (discordId) {
    const used = await db.execute({
      sql: `SELECT 1 FROM purchases WHERE guild_id = ? AND discord_id = ? AND discount_code = ? AND status = 'completed' LIMIT 1`,
      args: [guildId, discordId, code],
    });
    if (used.rows.length > 0) return { error: 'Je hebt deze kortingscode al eens gebruikt.' };
  }

  return {
    code: {
      id: row.id,
      code: row.code,
      percentOff: row.percent_off !== null && row.percent_off !== undefined ? Number(row.percent_off) : null,
      amountOffCents: row.amount_off_cents !== null && row.amount_off_cents !== undefined ? Number(row.amount_off_cents) : null,
    },
  };
}

// products: product-rijen (uit de database). Geeft het volledige prijsoverzicht.
async function priceCart({ products, guildId, code, discordId }) {
  const bundles = await getActiveBundles(guildId);
  const cartIds = new Set(products.map((p) => p.id));

  const appliedBundles = bundles.filter(
    (b) => b.productIds.length >= 2 && b.discountPercent > 0 && b.productIds.every((id) => cartIds.has(id))
  );

  const items = products.map((p) => {
    const original = Number(p.price_cents);
    let bundlePct = 0;
    if (original > 0) {
      for (const b of appliedBundles) {
        if (b.productIds.includes(p.id)) bundlePct = Math.max(bundlePct, b.discountPercent);
      }
    }
    const afterBundle = Math.round((original * (100 - bundlePct)) / 100);
    return {
      id: p.id,
      name: p.name,
      originalCents: original,
      bundleDiscountCents: original - afterBundle,
      codeDiscountCents: 0,
      finalCents: afterBundle,
    };
  });

  // Kortingscode
  const lookup = await lookupCode(guildId, code, discordId);
  let appliedCode = null;
  if (lookup.code) {
    appliedCode = lookup.code;
    const payable = items.filter((i) => i.finalCents > 0);
    const base = payable.reduce((sum, i) => sum + i.finalCents, 0);

    if (appliedCode.percentOff) {
      for (const i of payable) {
        const off = Math.round((i.finalCents * appliedCode.percentOff) / 100);
        i.codeDiscountCents = off;
        i.finalCents -= off;
      }
    } else if (appliedCode.amountOffCents && base > 0) {
      let remaining = Math.min(appliedCode.amountOffCents, base);
      const total = remaining;
      // Evenredig verdelen (afgerond naar beneden), restant op het duurste product.
      for (const i of payable) {
        const share = Math.floor((total * i.finalCents) / base);
        i.codeDiscountCents = share;
        remaining -= share;
      }
      if (remaining > 0) {
        const biggest = [...payable].sort((a, b) => b.finalCents - a.finalCents)[0];
        biggest.codeDiscountCents += remaining;
      }
      for (const i of payable) i.finalCents -= i.codeDiscountCents;
    }
  }

  const sum = (key) => items.reduce((s, i) => s + i[key], 0);
  return {
    items,
    subtotalCents: sum('originalCents'),
    bundleDiscountCents: sum('bundleDiscountCents'),
    codeDiscountCents: sum('codeDiscountCents'),
    totalCents: sum('finalCents'),
    bundles: appliedBundles.map((b) => ({ id: b.id, name: b.name, percent: b.discountPercent })),
    code: appliedCode ? { code: appliedCode.code, percentOff: appliedCode.percentOff, amountOffCents: appliedCode.amountOffCents } : null,
    codeError: lookup.error || null,
  };
}

module.exports = { priceCart, getActiveBundles, lookupCode, normalizeCode, parseIds };
