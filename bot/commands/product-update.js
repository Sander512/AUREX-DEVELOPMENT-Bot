// bot/commands/product-update.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { attachmentToUpload, addPhotoOptions, collectPhotoUploads, uploadPhotosBatched } = require('../utils/productFile');

async function findProductByName(guildId, name) {
  const { products } = await api.listProducts(guildId);
  return products.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

module.exports = {
  data: addPhotoOptions(
    new SlashCommandBuilder()
    .setName('product-update')
    .setDescription('[Management] Werk een bestaand product bij')
    .addStringOption((opt) =>
      opt.setName('naam').setDescription('Product om bij te werken').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((opt) => opt.setName('nieuwe_versie').setDescription('Nieuw versienummer, bv. 1.1.0').setMaxLength(100))
    .addStringOption((opt) => opt.setName('changelog').setDescription('Wat is er veranderd').setMaxLength(4000))
    .addNumberOption((opt) => opt.setName('nieuwe_prijs').setDescription('Nieuwe prijs, bv. 24.99 (0 = gratis)').setMinValue(0))
    .addAttachmentOption((opt) => opt.setName('bestand').setDescription('Nieuw bestand voor kopers (vervangt het huidige)'))
    .addStringOption((opt) => opt.setName('omschrijving').setDescription('Nieuwe omschrijving').setMaxLength(4000))
    .addStringOption((opt) => opt.setName('categorie').setDescription('Nieuwe categorie').setMaxLength(60))
    .addStringOption((opt) =>
      opt.setName('afbeeldingen').setDescription('Nieuwe foto-links (spatie/komma ertussen) — vervangt de oude').setMaxLength(2000)
    )
    .addBooleanOption((opt) => opt.setName('actief').setDescription('Zichtbaar/kopen in de webshop'))
    .addBooleanOption((opt) =>
      opt.setName('stuur_update').setDescription('DM naar alle kopers, mét het nieuwe bestand als je bestand meestuurt (standaard: nee)')
    ),
    { mode: 'append' }
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

    let product;
    try {
      product = await findProductByName(interaction.guildId, name);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Laden mislukt', err.message)] });
      return;
    }

    if (!product) {
      await interaction.editReply({
        embeds: [embeds.error('Niet gevonden', `Geen product met de naam "${name}". Gebruik \`/product-list\` om de exacte naam te zien.`)],
      });
      return;
    }

    const fields = {};
    const nieuweVersie = interaction.options.getString('nieuwe_versie');
    const changelog = interaction.options.getString('changelog');
    const nieuwePrijs = interaction.options.getNumber('nieuwe_prijs');
    const omschrijving = interaction.options.getString('omschrijving');
    const actief = interaction.options.getBoolean('actief');
    const stuurUpdate = interaction.options.getBoolean('stuur_update') || false;

    if (nieuweVersie !== null) fields.version = nieuweVersie;
    if (changelog !== null) fields.changelog = changelog;
    if (nieuwePrijs !== null) fields.priceCents = Math.round(nieuwePrijs * 100);
    if (omschrijving !== null) fields.description = omschrijving;
    if (actief !== null) fields.active = actief;
    const categorie = interaction.options.getString('categorie');
    const afbeeldingen = interaction.options.getString('afbeeldingen');
    if (categorie !== null) fields.category = categorie;
    if (afbeeldingen !== null) fields.imageUrls = afbeeldingen.split(/[\s,]+/).filter(Boolean);

    const newFile = interaction.options.getAttachment('bestand');
    if (fields.priceCents !== undefined && fields.priceCents > 0 && fields.priceCents < 50) {
      await interaction.editReply({
        embeds: [embeds.error('Prijs te laag', 'Een betaald product kost minimaal 0,50. Vul 0 in voor een gratis product.')],
      });
      return;
    }

    let upload = null;
    if (newFile) {
      try {
        upload = await attachmentToUpload(newFile);
      } catch (err) {
        await interaction.editReply({ embeds: [embeds.error('Bestand niet gelukt', err.message)] });
        return;
      }
    }

    let photos;
    try {
      photos = await collectPhotoUploads(interaction);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Foto niet gelukt', err.message)] });
      return;
    }

    if (Object.keys(fields).length === 0 && !upload && photos.length === 0) {
      await interaction.editReply({ embeds: [embeds.warning('Niets om bij te werken', 'Vul minstens één veld in om te wijzigen.')] });
      return;
    }

    try {
      if (Object.keys(fields).length > 0) await api.updateProduct(interaction.guildId, product.id, fields);
      if (upload) await api.uploadProductFile(interaction.guildId, product.id, upload);
      // Nieuwe foto's worden achteraan toegevoegd (de cover blijft). Alles vervangen kan met /product fotos.
      if (photos.length > 0) await uploadPhotosBatched(interaction.guildId, product.id, photos, false);
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Bijwerken mislukt', err.message)] });
      return;
    }

    let notifyNote = '';
    if (stuurUpdate) {
      try {
        const result = await api.notifyProduct(interaction.guildId, product.id, !!upload);
        notifyNote = `\n\n🔔 ${result.message || `DM klaargezet voor ${result.queued} koper(s).`}`;
          if (!upload && result.queued > 0) {
            notifyNote += '\nℹ️ Je hebt geen nieuw bestand meegestuurd, dus kopers kregen alleen de tekst (versie/changelog). Voeg `bestand` toe om ook de nieuwe versie mee te sturen.';
          }
      } catch (err) {
        notifyNote = `\n\n⚠️ Product is bijgewerkt, maar de update-DM versturen mislukte: ${err.message}`;
      }
    }

    await interaction.editReply({
      embeds: [embeds.success('Product bijgewerkt', `**${product.name}** is bijgewerkt.${notifyNote}`)],
    });
  },
};
