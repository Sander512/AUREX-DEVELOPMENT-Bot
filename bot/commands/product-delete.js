// bot/commands/product-delete.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('product-delete')
    .setDescription('[Management] Verwijder een product uit de webshop')
    .addStringOption((opt) =>
      opt.setName('naam').setDescription('Product om te verwijderen').setRequired(true).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    try {
      const { products } = await api.listProducts(interaction.guildId);
      const filtered = products
        .filter((p) => p.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25)
        .map((p) => ({ name: p.name, value: p.name }));
      await interaction.respond(filtered);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const name = interaction.options.getString('naam', true);

    try {
      const { products } = await api.listProducts(interaction.guildId);
      const product = products.find((p) => p.name.toLowerCase() === name.toLowerCase());

      if (!product) {
        await interaction.editReply({
          embeds: [embeds.error('Niet gevonden', `Geen product met de naam "${name}".`)],
        });
        return;
      }

      await api.deleteProduct(interaction.guildId, product.id);

      await interaction.editReply({
        embeds: [embeds.success('Product verwijderd', `**${product.name}** is uit de webshop verwijderd. Eerdere aankopen blijven bewaard.`)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Verwijderen mislukt', err.message)] });
    }
  },
};
