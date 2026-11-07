const logger = require('./logger');

const DELETE_AFTER_MS = 5 * 60 * 1000;
const timers = new Map();

function scheduleTicketAutoDelete(client, channelId, closedAt = Date.now()) {
  const closedAtMs = Number(closedAt);
  if (!client || !channelId || !Number.isFinite(closedAtMs) || closedAtMs <= 0) return;

  const deleteAt = closedAtMs + DELETE_AFTER_MS;
  const current = timers.get(channelId);
  if (current && current.deleteAt <= deleteAt) return;
  if (current) clearTimeout(current.timer);

  const timer = setTimeout(async () => {
    timers.delete(channelId);
    try {
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;
      await channel.delete('Ticket automatically deleted 5 minutes after closure');
      logger.info(`Gesloten ticketkanaal ${channelId} automatisch verwijderd.`);
    } catch (err) {
      if (err?.code !== 10003) logger.warn(`Gesloten ticketkanaal ${channelId} kon niet automatisch worden verwijderd: ${err.message}`);
    }
  }, Math.min(Math.max(0, deleteAt - Date.now()), 2_147_000_000));
  timer.unref?.();
  timers.set(channelId, { deleteAt, timer });
}

module.exports = { DELETE_AFTER_MS, scheduleTicketAutoDelete };
