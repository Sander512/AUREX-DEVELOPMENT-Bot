const { EmbedBuilder } = require("discord.js");
const { prisma } = require("../database/prisma");
const { ACCENT_COLOR } = require("../config");

async function handleTicketButton(interaction) {
  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId } });
  if (!ticket) {
    return interaction.reply({ content: "Dit kanaal is niet gekoppeld aan een ticket.", ephemeral: true });
  }

  if (interaction.customId === "aurex:ticket:claim") {
    if (ticket.status === "CLAIMED") {
      return interaction.reply({ content: `Al geclaimd door <@${ticket.claimedById}>.`, ephemeral: true });
    }
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: "CLAIMED", claimedById: interaction.user.id },
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(ACCENT_COLOR).setDescription(`🎫 Ticket geclaimd door <@${interaction.user.id}>.`)],
    });
  }

  if (interaction.customId === "aurex:ticket:close") {
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await interaction.reply("🔒 Ticket wordt gesloten en gearchiveerd...");
    // TODO: generate transcript (e.g. via discord-html-transcripts) and post
    // it to the logTickets channel before deleting/archiving the channel.
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
}

module.exports = { handleTicketButton };
