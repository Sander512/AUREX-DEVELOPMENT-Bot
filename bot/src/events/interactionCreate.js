const { handleTicketCreate } = require("../handlers/ticketCreateHandler");
const { handleTicketButton } = require("../handlers/ticketButtonHandler");

module.exports = {
  name: "interactionCreate",
  async execute(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) return;
        return command.execute(interaction);
      }

      if (interaction.isStringSelectMenu() && interaction.customId === "aurex:ticket:create") {
        return handleTicketCreate(interaction);
      }

      if (interaction.isButton() && interaction.customId.startsWith("aurex:ticket:")) {
        return handleTicketButton(interaction);
      }

      // Future routing: aurex:embed:*, aurex:verify:*, aurex:order:* etc.
    } catch (err) {
      console.error("[interaction] Unhandled error:", err);
      const payload = { content: "Er ging iets mis. Dit is gelogd.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
