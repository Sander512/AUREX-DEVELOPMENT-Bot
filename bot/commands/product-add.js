// bot/commands/product-add.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('product-add')
    .setDescription('[Management] Voeg een product toe aan de webshop')
    .addStringOption((opt) => opt.setName('naam').setDescription('Productnaam').setRequired(true).setMaxLength(200))
    .addNumberOption((opt) =>
      opt.setName('prijs').setDescription('Prijs, bv. 19.99').setRequired(true).setMinValue(0.01)
    )
    .addStringOption((opt) => opt.setName('omschrijving').setDescription('Korte omschrijving').setMaxLength(4000))
    .addStringOption((opt) => opt.setName('versie').setDescription('Versienummer, bv. 1.0.0').setMaxLength(100))
    .addStringOption((opt) => opt.setName('changelog').setDescription('Wat is er nieuw/anders').setMaxLength(4000))
    .addStringOption((opt) =>
      opt
        .setName('valuta')
        .setDescription('Standaard: EUR')
        .addChoices({ name: 'EUR', value: 'eur' }, { name: 'USD', value: 'usd' }, { name: 'GBP', value: 'gbp' })
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const priceEuros = interaction.options.getNumber('prijs', true);

    try {
      const { product } = await api.addProduct(interaction.guildId, {
        name: interaction.options.getString('naam', true),
        priceCents: Math.round(priceEuros * 100),
        description: interaction.options.getString('omschrijving') || null,
        version: interaction.options.getString('versie') || null,
        changelog: interaction.options.getString('changelog') || null,
        currency: interaction.options.getString('valuta') || 'eur',
      });

      await interaction.editReply({
        embeds: [
          embeds.success(
            'Product toegevoegd',
            `**${product.name}** staat nu in de webshop voor **${(product.priceCents / 100).toFixed(2)} ${product.currency.toUpperCase()}**.\nGebruik \`/product-list\` om alle producten te zien, of \`/product-update\` om 'm later bij te werken.`
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Toevoegen mislukt', err.message)] });
    }
  },
};
