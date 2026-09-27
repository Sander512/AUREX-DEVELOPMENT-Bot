const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { prisma } = require("../database/prisma");
const { ACCENT_COLOR } = require("../config");
const { parseJson } = require("../../lib/json");

/**
 * Fired when a customer picks a category from the ticket panel's select menu.
 * Creates a private channel visible only to the opener + that category's
 * support roles, writes the Ticket row, and posts the control buttons.
 */
async function handleTicketCreate(interaction) {
  const categoryId = interaction.values[0];
  const category = await prisma.ticketCategory.findUnique({ where: { id: categoryId } });
  if (!category) {
    return interaction.reply({ content: "Deze categorie bestaat niet meer.", ephemeral: true });
  }

  // Prevent duplicate open tickets in the same category for the same user.
  const existing = await prisma.ticket.findFirst({
    where: {
      guildId: interaction.guildId,
      categoryId,
      openerId: interaction.user.id,
      status: { in: ["OPEN", "CLAIMED", "REOPENED"] },
    },
  });
  if (existing) {
    return interaction.reply({
      content: `Je hebt al een open ticket voor deze categorie: <#${existing.channelId}>`,
      ephemeral: true,
    });
  }

  const count = await prisma.ticket.count({ where: { guildId: interaction.guildId } });
  const ticketNumber = count + 1;

  const overwrites = [
    { id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    ...parseJson(category.supportRoleIds, []).map((roleId) => ({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];

  const channel = await interaction.guild.channels.create({
    name: `ticket-${String(ticketNumber).padStart(4, "0")}`,
    type: ChannelType.GuildText,
    parent: category.discordCategoryId || undefined,
    permissionOverwrites: overwrites,
  });

  await prisma.ticket.create({
    data: {
      guildId: interaction.guildId,
      categoryId,
      channelId: channel.id,
      number: ticketNumber,
      openerId: interaction.user.id,
    },
  });

  const embed = new EmbedBuilder()
    .setColor(ACCENT_COLOR)
    .setTitle(`Ticket #${String(ticketNumber).padStart(4, "0")} — ${category.label}`)
    .setDescription(`Welkom <@${interaction.user.id}>! Beschrijf je vraag zo duidelijk mogelijk, ons team reageert snel.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("aurex:ticket:claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("aurex:ticket:close").setLabel("Close").setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });

  await interaction.reply({ content: `Ticket aangemaakt: ${channel}`, ephemeral: true });
}

module.exports = { handleTicketCreate };
