// bot/utils/api.js
// Thin HTTP client the bot uses to talk to the Aurex | Development API.
// Every request is authenticated with X-API-Key.

const config = require('../config');

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const url = `${config.api.baseUrl}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.api.key,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(`Kon geen verbinding maken met de API (${url}): ${err.message}`, 0, null);
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = (data && data.error) || `API request failed with status ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  return data;
}

const api = {
  ApiError,

  // ---- Discord guilds (powers the dashboard's "kies een server" screen) ----
  syncDiscordGuilds: (guilds) => request('POST', '/discord-guilds/sync', { guilds }),
  upsertDiscordGuild: (id, name, icon) => request('POST', '/discord-guilds/upsert', { id, name, icon }),
  removeDiscordGuild: (guildId) => request('DELETE', `/discord-guilds/${guildId}`),

  // ---- Ticket panel system ----
  getTicketConfig: (guildId) => request('GET', `/tickets/config/${guildId}`),
  updateTicketConfig: (guildId, fields) => request('POST', '/tickets/config', { guildId, ...fields }),
  listTicketTypes: (guildId) => request('GET', `/tickets/types/${guildId}`),
  addTicketType: (guildId, type) => request('POST', '/tickets/types', { guildId, ...type }),
  updateTicketType: (guildId, key, fields) =>
    request('PATCH', `/tickets/types/${guildId}/${encodeURIComponent(key)}`, fields),
  removeTicketType: (guildId, key) => request('DELETE', `/tickets/types/${guildId}/${encodeURIComponent(key)}`),
  createTicketRecord: (data) => request('POST', '/tickets/create', data),
  getOpenTicketCount: (guildId, openerId, typeKey) =>
    request('GET', `/tickets/open-count/${guildId}/${openerId}${typeKey ? `?typeKey=${encodeURIComponent(typeKey)}` : ''}`),
  getTicketByChannel: (channelId) => request('GET', `/tickets/by-channel/${channelId}`),
  listTickets: (guildId, status) => request('GET', `/tickets/list/${guildId}${status ? `?status=${status}` : ''}`),
  claimTicket: (channelId, claimedBy) => request('POST', '/tickets/claim', { channelId, claimedBy }),
  closeTicket: (channelId, closedBy, reason) => request('POST', '/tickets/close', { channelId, closedBy, reason }),

  // ---- Welcome messages ----
  getWelcomeConfig: (guildId) => request('GET', `/welcome/config/${guildId}`),

  // ---- Verify panel (role-based, no external account linking) ----
  getVerifyConfig: (guildId) => request('GET', `/verify/config/${guildId}`),
  updateVerifyConfig: (guildId, fields) => request('POST', '/verify/config', { guildId, ...fields }),

  // ---- Rules ----
  getRulesConfig: (guildId) => request('GET', `/rules/config/${guildId}`),
  updateRulesConfig: (guildId, fields) => request('POST', '/rules/config', { guildId, ...fields }),
  setRulesMessageId: (guildId, messageId) => request('POST', '/rules/message', { guildId, messageId }),

  // ---- Webshop DM-wachtrij ----
  // De API heeft zelf geen Discord-verbinding, dus zet klaarstaande DM's in
  // een tabel; de bot pollt die hier leeg (zie bot/utils/dmQueue.js).
  getPendingDms: (limit = 10) => request('GET', `/store/pending-dms?limit=${limit}`),
  markDmStatus: (id, status) => request('POST', `/store/pending-dms/${id}/status`, { status }),

  // ---- Webshop producten (ook beheerbaar via Discord-commando's) ----
  listProducts: (guildId) => request('GET', `/store/admin/products/${guildId}`),
  addProduct: (guildId, fields) => request('POST', '/store/admin/products', { guildId, ...fields }),
  updateProduct: (guildId, id, fields) => request('POST', `/store/admin/products/${id}`, { guildId, ...fields }),
  deleteProduct: (guildId, id) => request('DELETE', `/store/admin/products/${id}`, { guildId }),
  uploadProductFile: (guildId, id, file) =>
    request('POST', `/store/admin/product-file/${id}`, { guildId, ...file }),
  getProductFile: (productId) => request('GET', `/store/product-file/${productId}`),
  notifyProduct: (guildId, id) => request('POST', `/store/admin/products/${id}/notify`, { guildId }),
};

module.exports = api;
