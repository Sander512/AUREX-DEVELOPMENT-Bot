// bot/utils/productFile.js
// Haalt een Discord-bijlage op en zet hem klaar voor de API. Discord-CDN-links
// verlopen na verloop van tijd, dus we bewaren nooit de link zelf maar het
// bestand (in de database, via de API).

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB — zie ook api/routes/store.js

async function attachmentToUpload(attachment) {
  if (attachment.size > MAX_FILE_BYTES) {
    throw new Error(
      `Het bestand is te groot (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_BYTES / 1024 / 1024} MB). Gebruik voor grote bestanden het dashboard i.p.v. /product — Discord staat sowieso geen bijlage van deze grootte toe bij een slash command.`
    );
  }

  let response;
  try {
    response = await fetch(attachment.url);
  } catch (err) {
    throw new Error(`Kon het bijgevoegde bestand niet downloaden: ${err.message}`);
  }
  if (!response.ok) throw new Error(`Kon het bijgevoegde bestand niet downloaden (status ${response.status}).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    fileName: attachment.name || 'bestand',
    mimeType: attachment.contentType || 'application/octet-stream',
    dataBase64: buffer.toString('base64'),
  };
}

// ---- Productfoto's (/product add, /product update, /product fotos) ----
// Discord geeft per slash-command geen "meerdere bijlagen in één veld", dus
// er zijn losse velden foto1 t/m foto15. foto1 = cover (hoofdfoto); de
// volgorde van de velden is de volgorde waarin er in de shop doorheen
// gebladerd wordt. Max 15 foto's / max 8 MB per foto (zie api/routes/store.js).
// LET OP: Discord staat max 25 opties per commando toe — met 15 fotovelden
// blijven er dus maximaal 10 andere opties over in /product update.
const MAX_PHOTOS = 15;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const api = require('./api');

// mode: 'add' (nieuw product), 'append' (foto's achteraan toevoegen) of
// 'replace' (alle huidige foto's vervangen).
function addPhotoOptions(builder, { mode = 'add' } = {}) {
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    let description;
    if (mode === 'append') {
      description = i === 1 ? `Nieuwe foto (wordt achteraan toegevoegd; max ${MAX_PHOTOS} totaal)` : `Nieuwe foto ${i} (wordt achteraan toegevoegd)`;
    } else if (mode === 'replace') {
      description = i === 1 ? "Nieuwe cover (vervangt ALLE huidige foto's)" : `Foto ${i} (volgorde van de velden = volgorde in de shop)`;
    } else {
      description = i === 1 ? 'Cover-foto (foto1 = hoofdfoto, PNG/JPG/WEBP/GIF)' : `Foto ${i} — volgorde van de velden = volgorde in de shop`;
    }
    builder.addAttachmentOption((opt) => opt.setName(`foto${i}`).setDescription(description));
  }
  return builder;
}

async function imageAttachmentToUpload(attachment, label) {
  const type = String(attachment.contentType || '').toLowerCase().split(';')[0].trim();
  if (!IMAGE_TYPES.has(type)) {
    throw new Error(`${label} is geen geldige afbeelding. Gebruik PNG, JPG, WEBP of GIF.`);
  }
  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new Error(`${label} is te groot (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB per foto).`);
  }

  let response;
  try {
    response = await fetch(attachment.url);
  } catch (err) {
    throw new Error(`Kon ${label} niet downloaden: ${err.message}`);
  }
  if (!response.ok) throw new Error(`Kon ${label} niet downloaden (status ${response.status}).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    fileName: attachment.name || `${label}.png`,
    mimeType: type,
    dataBase64: buffer.toString('base64'),
  };
}

// Leest foto1..foto15 uit de interaction (lege velden worden overgeslagen,
// de volgorde blijft die van de velden) en zet ze klaar voor de API.
async function collectPhotoUploads(interaction) {
  const uploads = [];
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    const attachment = interaction.options.getAttachment(`foto${i}`);
    if (!attachment) continue;
    uploads.push(await imageAttachmentToUpload(attachment, `Foto ${i}`));
  }
  return uploads;
}

// Stuurt foto's in porties naar de API (max ~40 MB base64 per request), zodat
// 15 grote foto's nooit in één enorme request hoeven. Bij replace=true gaat de
// eerste portie als "vervang alles" en de rest wordt erachter gezet.
async function uploadPhotosBatched(guildId, productId, photos, replace) {
  const MAX_BATCH_CHARS = 40 * 1024 * 1024;
  let batch = [];
  let size = 0;
  let first = true;
  const flush = async () => {
    if (batch.length === 0) return;
    await api.uploadProductImages(guildId, productId, batch, !!replace && first);
    first = false;
    batch = [];
    size = 0;
  };
  for (const photo of photos) {
    if (batch.length > 0 && size + photo.dataBase64.length > MAX_BATCH_CHARS) await flush();
    batch.push(photo);
    size += photo.dataBase64.length;
  }
  await flush();
}

module.exports = { attachmentToUpload, MAX_FILE_BYTES, MAX_PHOTOS, addPhotoOptions, collectPhotoUploads, uploadPhotosBatched };
