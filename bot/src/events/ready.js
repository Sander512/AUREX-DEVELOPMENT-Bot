module.exports = {
  name: "ready",
  once: true,
  execute(client) {
    console.log(`[bot] Ingelogd als ${client.user.tag}`);
    client.user.setActivity("AUREX DEVELOPMENT | /dashboard");
  },
};
