// bot/commands/product.js
// Eén command voor het hele webshop-beheer: toevoegen, bijwerken,
// verwijderen, tonen, en het kanaal instellen waar automatisch bijgehouden
// wordt wat er allemaal in de webshop staat.

const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { attachmentToUpload, addPhotoOptions, collectPhotoUploads, uploadPhotosBatched } = require('../utils/productFile');
const { refreshGuildNow } = require('../utils/productChannel');

async function findProductByName(guildId, name) {
  const { products } = await api.listProducts(guildId);
  return products.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

async function autocompleteProductName(interaction) {
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
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('product')
    .setDescription('[Management] Beheer de webshop')
    .addSubcommand((sub) =>
      addPhotoOptions(
        sub
        .setName('add')
        .setDescription('Voeg een product toe aan de webshop')
        .addStringOption((opt) => opt.setName('naam').setDescription('Productnaam').setRequired(true).setMaxLength(200))
        .addNumberOption((opt) =>
          opt.setName('prijs').setDescription('Prijs, bv. 19.99 — vul 0 in voor een gratis product').setRequired(true).setMinValue(0)
        )
        .addAttachmentOption((opt) =>
          opt.setName('bestand').setDescription('Bestand voor kopers (max ~10 MB, groter? gebruik dashboard)').setRequired(true)
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
      )
    )
    .addSubcommand((sub) =>
      addPhotoOptions(
        sub
        .setName('update')
        .setDescription('Werk een bestaand product bij')
        .addStringOption((opt) =>
          opt.setName('naam').setDescription('Product om bij te werken').setRequired(true).setAutocomplete(true)
        )
        .addNumberOption((opt) => opt.setName('nieuwe_prijs').setDescription('Nieuwe prijs, bv. 24.99 (0 = gratis)').setMinValue(0))
        .addAttachmentOption((opt) => opt.setName('bestand').setDescription('Nieuw bestand voor kopers (vervangt het huidige)'))
        .addStringOption((opt) => opt.setName('nieuwe_versie').setDescription('Nieuw versienummer, bv. 1.1.0').setMaxLength(100))
        .addStringOption((opt) => opt.setName('changelog').setDescription('Wat is er veranderd').setMaxLength(4000))
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
      )
    )
    .addSubcommand((sub) =>
      addPhotoOptions(
        sub
          .setName('fotos')
          .setDescription("Vervang ALLE foto's van een product (foto1 = cover)")
          .addStringOption((opt) =>
            opt.setName('naam').setDescription('Product waarvan je de foto\'s vervangt').setRequired(true).setAutocomplete(true)
          ),
        { mode: 'replace' }
      )
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Verwijder een product uit de webshop')
        .addStringOption((opt) =>
          opt.setName('naam').setDescription('Product om te verwijderen').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Toon alle producten in de webshop'))
    .addSubcommand((sub) =>
      sub
        .setName('kanaal')
        .setDescription('Stel het kanaal in waar automatisch staat wat er in de webshop staat')
        .addChannelOption((opt) =>
          opt
            .setName('kanaal')
            .setDescription('Kanaal voor het webshop-overzicht')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    ),

  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'update' || sub === 'delete' || sub === 'fotos') return autocompleteProductName(interaction);
    await interaction.respond([]);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') return executeAdd(interaction);
    if (sub === 'update') return executeUpdate(interaction);
    if (sub === 'fotos') return executeFotos(interaction);
    if (sub === 'delete') return executeDelete(interaction);
    if (sub === 'list') return executeList(interaction);
    if (sub === 'kanaal') return executeKanaal(interaction);
  },
};

async function executeAdd(interaction) {
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
    await api.deleteProduct(interaction.guildId, product.id).catch(() => {});
    await interaction.editReply({
      embeds: [embeds.error('Bestand uploaden mislukt', `Het product is niet toegevoegd. ${err.message}`)],
    });
    return;
  }

  // Foto's: het product staat er al mét bestand, dus een mislukte foto-upload
  // is geen reden om alles terug te draaien — wel melden.
  let photoNote = '';
  if (photos.length > 0) {
    try {
      await uploadPhotosBatched(interaction.guildId, product.id, photos, true);
      photoNote = `\n**Foto's/video's:** ${photos.length} (foto1 = cover)`;
    } catch (err) {
      photoNote = `\n⚠️ Het product staat erin, maar de foto's uploaden mislukte: ${err.message}. Voeg ze toe via \`/product update\` of het dashboard.`;
    }
  }

  refreshGuildNow(interaction.client, interaction.guildId).catch(() => {});

  const priceText = product.priceCents === 0 ? 'Gratis' : `${(product.priceCents / 100).toFixed(2)} ${product.currency.toUpperCase()}`;
  await interaction.editReply({
    embeds: [
      embeds.success(
        'Product toegevoegd',
        `**${product.name}** staat nu in de webshop.\n**Prijs:** ${priceText}\n**Bestand:** ${upload.fileName}${photoNote}\n\nGebruik \`/product list\` voor een overzicht of \`/product update\` om het later bij te werken.`
      ),
    ],
  });
}

async function executeUpdate(interaction) {
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
      embeds: [embeds.error('Niet gevonden', `Geen product met de naam "${name}". Gebruik \`/product list\` om de exacte naam te zien.`)],
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
  const categorie = interaction.options.getString('categorie');
  const afbeeldingen = interaction.options.getString('afbeeldingen');

  if (nieuweVersie !== null) fields.version = nieuweVersie;
  if (changelog !== null) fields.changelog = changelog;
  if (nieuwePrijs !== null) fields.priceCents = Math.round(nieuwePrijs * 100);
  if (omschrijving !== null) fields.description = omschrijving;
  if (actief !== null) fields.active = actief;
  if (categorie !== null) fields.category = categorie;
  if (afbeeldingen !== null) fields.imageUrls = afbeeldingen.split(/[\s,]+/).filter(Boolean);

  if (fields.priceCents !== undefined && fields.priceCents > 0 && fields.priceCents < 50) {
    await interaction.editReply({
      embeds: [embeds.error('Prijs te laag', 'Een betaald product kost minimaal 0,50. Vul 0 in voor een gratis product.')],
    });
    return;
  }

  const newFile = interaction.options.getAttachment('bestand');
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

  refreshGuildNow(interaction.client, interaction.guildId).catch(() => {});

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
}

async function executeFotos(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const product = await findProductByName(interaction.guildId, interaction.options.getString('naam', true));
  if (!product) {
    await interaction.editReply({ embeds: [embeds.error('Niet gevonden', 'Geen product met die naam. Kies er een uit de lijst.')] });
    return;
  }

  let photos;
  try {
    photos = await collectPhotoUploads(interaction);
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Foto niet gelukt', err.message)] });
    return;
  }
  if (photos.length === 0) {
    await interaction.editReply({ embeds: [embeds.warning('Geen foto\'s', 'Voeg minstens één foto toe (foto1 wordt de cover).')] });
    return;
  }

  try {
    await uploadPhotosBatched(interaction.guildId, product.id, photos, true);
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Foto\'s uploaden mislukt', err.message)] });
    return;
  }

  refreshGuildNow(interaction.client, interaction.guildId).catch(() => {});
  await interaction.editReply({
    embeds: [embeds.success("Foto's vervangen", `**${product.name}** heeft nu ${photos.length} foto${photos.length === 1 ? '' : "'s"} (foto1 = cover).`)],
  });
}

async function executeDelete(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const name = interaction.options.getString('naam', true);

  try {
    const product = await findProductByName(interaction.guildId, name);

    if (!product) {
      await interaction.editReply({ embeds: [embeds.error('Niet gevonden', `Geen product met de naam "${name}".`)] });
      return;
    }

    await api.deleteProduct(interaction.guildId, product.id);
    refreshGuildNow(interaction.client, interaction.guildId).catch(() => {});

    await interaction.editReply({
      embeds: [embeds.success('Product verwijderd', `**${product.name}** is uit de webshop verwijderd. Eerdere aankopen blijven bewaard.`)],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Verwijderen mislukt', err.message)] });
  }
}

async function executeList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { products } = await api.listProducts(interaction.guildId);

    if (products.length === 0) {
      await interaction.editReply({
        embeds: [embeds.info('Nog geen producten', 'Gebruik `/product add` om je eerste product toe te voegen.')],
      });
      return;
    }

    const lines = products.map((p) => {
      const status = p.active ? '🟢' : '⚪';
      const version = p.version ? ` (v${p.version})` : '';
      const price = p.priceCents === 0 ? 'Gratis' : `${(p.priceCents / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
      const fileNote = p.hasFile ? '' : ' ⚠️ geen bestand';
      return `${status} **${p.name}**${version} — ${price}${fileNote}`;
    });

    await interaction.editReply({
      embeds: [
        embeds.info(
          'Webshop producten',
          `${lines.join('\n')}\n\n🟢 = actief · ⚪ = inactief\n⚠️ = nog geen bestand gekoppeld; gebruik \`/product update\` met de optie *bestand*.`
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Laden mislukt', err.message)] });
  }
}

async function executeKanaal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.options.getChannel('kanaal', true);

  try {
    await api.setProductChannel(interaction.guildId, channel.id);
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Instellen mislukt', err.message)] });
    return;
  }

  refreshGuildNow(interaction.client, interaction.guildId).catch((err) => {
    interaction.client?.logger?.error?.('Kon webshop-overzicht niet meteen versturen:', err);
  });

  await interaction.editReply({
    embeds: [
      embeds.success(
        'Webshop-kanaal ingesteld',
        `${channel} houdt nu automatisch bij wat er in de webshop staat. Het overzicht verschijnt binnen enkele seconden en wordt vanzelf bijgewerkt zodra er iets verandert.`
      ),
    ],
  });
}
