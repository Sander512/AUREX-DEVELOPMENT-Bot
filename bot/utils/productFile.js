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
// Video's gaan via dezelfde fotovelden (foto1..foto15) en staan in dezelfde
// volgorde in de galerij. MP4/WEBM, max 50 MB, max 3 per product (zie api/routes/store.js).
// Let op: Discord bepaalt zelf hoe groot een bijlage bij een slash command mag zijn
// (vaak ~10 MB). Past je video daar niet in, upload hem dan via het dashboard.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEOS = 3;
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const api = require('./api');

// mode: 'add' (nieuw product), 'append' (foto's achteraan toevoegen) of
// 'replace' (alle huidige foto's vervangen).
function addPhotoOptions(builder, { mode = 'add' } = {}) {
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    let description;
    if (mode === 'append') {
      description = i === 1 ? `Nieuwe foto of video (komt achteraan; max ${MAX_PHOTOS} totaal)` : `Nieuwe foto of video ${i} (komt achteraan)`;
    } else if (mode === 'replace') {
      description = i === 1 ? "Nieuwe cover (vervangt ALLE huidige foto's en video's)" : `Foto of video ${i} (volgorde van de velden = volgorde)`;
    } else {
      description = i === 1 ? 'Cover (foto1 = hoofdmedia; PNG/JPG/WEBP/GIF of MP4/WEBM-video)' : `Foto of video ${i} — volgorde van de velden = volgorde`;
    }
    builder.addAttachmentOption((opt) => opt.setName(`foto${i}`).setDescription(description));
  }
  return builder;
}

async function imageAttachmentToUpload(attachment, label) {
  const type = String(attachment.contentType || '').toLowerCase().split(';')[0].trim();
  const isVideo = VIDEO_TYPES.has(type);
  if (!IMAGE_TYPES.has(type) && !isVideo) {
    throw new Error(`${label} is geen geldig bestand. Gebruik PNG, JPG, WEBP, GIF of een MP4/WEBM-video.`);
  }
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (attachment.size > maxBytes) {
    throw new Error(
      `${label} is te groot (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max ${maxBytes / 1024 / 1024} MB per ${isVideo ? 'video' : 'foto'}).`
    );
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
    fileName: attachment.name || `${label}.${isVideo ? type.split('/')[1] : 'png'}`,
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
  const videos = uploads.filter((u) => VIDEO_TYPES.has(u.mimeType)).length;
  if (videos > MAX_VIDEOS) throw new Error(`Maximaal ${MAX_VIDEOS} video's per product (je stuurde er ${videos}).`);
  return uploads;
}

// Stuurt foto's en video's in porties naar de API (max ~40 MB base64 per request; één video van 50 MB gaat alleen), zodat
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
