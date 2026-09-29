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

module.exports = { attachmentToUpload, MAX_FILE_BYTES };
