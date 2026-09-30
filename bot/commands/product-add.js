// bot/commands/product-add.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { attachmentToUpload, addPhotoOptions, collectPhotoUploads } = require('../utils/productFile');

module.exports = {
  data: addPhotoOptions(
    new SlashCommandBuilder()
    .setName('product-add')
    .setDescription('[Management] Voeg een product toe aan de webshop')
    .addStringOption((opt) => opt.setName('naam').setDescription('Productnaam').setRequired(true).setMaxLength(200))
    .addNumberOption((opt) =>
      opt.setName('prijs').setDescription('Prijs, bv. 19.99 — vul 0 in voor een gratis product').setRequired(true).setMinValue(0)
    )
    .addAttachmentOption((opt) =>
      opt.setName('bestand').setDescription('Het bestand dat kopers ontvangen (max 8 MB, tip: zip)').setRequired(true)
    )
    .addStringOption((opt) => opt.setName('omschrijving').setDescription('Korte omschrijving').setMaxLength(4000))
    .addStringOption((opt) => opt.setName('versie').setDescription('Versienummer, bv. 1.0.0').setMaxLength(100))
    .addStringOption((opt) => opt.setName('changelog').setDescription('Wat is er nieuw/anders').setMaxLength(4000))
    .addStringOption((opt) => opt.setName('categorie').setDescription('Bv. Bots, Templates, Scripts').setMaxLength(60))
    .addStringOption((opt) =>
      opt.setName('afbeeldingen').setDescription('Foto-links (met spatie of komma ertussen), eerste = hoofdfoto').setMaxLength(2000)
    )
    .addStringOption((opt) =>
      opt
        .setName('valuta')
        .setDescription('Standaard: EUR')
        .addChoices({ name: 'EUR', value: 'eur' }, { name: 'USD', value: 'usd' }, { name: 'GBP', value: 'gbp' })
    )
  ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const priceEuros = interaction.options.getNumber('prijs', true);
    const priceCents = Math.round(priceEuros * 100);

    if (priceCents > 0 && priceCents < 50) {
      await interaction.editReply({
        embeds: [embeds.error('Prijs te laag', 'Een betaald product kost minimaal 0,50. Vul 0 in voor een gratis product.')],
      });
      return;
    }

    let upload;
    try {
      upload = await attachmentToUpload(interaction.options.getAttachment('bestand', true));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Bestand niet gelukt', err.message)] });
      return;
    }

    let photos;
    try {
      photos = await collectPhotoUploads(interaction);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Foto niet gelukt', err.message)] });
      return;
    }

    let product;
    try {
      ({ product } = await api.addProduct(interaction.guildId, {
        name: interaction.options.getString('naam', true),
        priceCents,
        description: interaction.options.getString('omschrijving') || null,
        version: interaction.options.getString('versie') || null,
        changelog: interaction.options.getString('changelog') || null,
        category: interaction.options.getString('categorie') || null,
        imageUrls: (interaction.options.getString('afbeeldingen') || '').split(/[\s,]+/).filter(Boolean),
        currency: interaction.options.getString('valuta') || 'eur',
      }));
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Toevoegen mislukt', err.message)] });
      return;
    }

    try {
      await api.uploadProductFile(interaction.guildId, product.id, upload);
    } catch (err) {
      // Geen product zonder bestand in de shop laten staan.
      await api.deleteProduct(interaction.guildId, product.id).catch(() => {});
      await interaction.editReply({
        embeds: [embeds.error('Bestand uploaden mislukt', `Het product is niet toegevoegd. ${err.message}`)],
      });
      return;
    }

    // Foto's: foto1 = cover. Een mislukte foto-upload draait het product niet terug.
    let photoNote = '';
    if (photos.length > 0) {
      try {
        await api.uploadProductImages(interaction.guildId, product.id, photos, true);
        photoNote = `\n**Foto's:** ${photos.length} (foto1 = cover)`;
      } catch (err) {
        photoNote = `\n⚠️ Het product staat erin, maar de foto's uploaden mislukte: ${err.message}. Voeg ze toe via \`/product-update\` of het dashboard.`;
      }
    }

    const priceText = product.priceCents === 0 ? 'Gratis' : `${(product.priceCents / 100).toFixed(2)} ${product.currency.toUpperCase()}`;
    await interaction.editReply({
      embeds: [
        embeds.success(
          'Product toegevoegd',
          `**${product.name}** staat nu in de webshop.\n**Prijs:** ${priceText}\n**Bestand:** ${upload.fileName}${photoNote}\n\nGebruik \`/product-list\` voor een overzicht of \`/product-update\` om het later bij te werken.`
        ),
      ],
    });
  },
};
