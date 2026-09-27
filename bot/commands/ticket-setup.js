// bot/commands/ticket-setup.js
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { hexToInt } = require('../utils/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('[Management] Stel het ticket panel volledig naar wens in')
    .addStringOption((opt) =>
      opt.setName('titel').setDescription('Titel van het panel embed').setMaxLength(256)
    )
    .addStringOption((opt) =>
      opt.setName('beschrijving').setDescription('Beschrijvingstekst van het panel embed').setMaxLength(2000)
    )
    .addStringOption((opt) =>
      opt.setName('kleur').setDescription('Hex kleurcode, bv. 1e3a8a of #1e3a8a').setMaxLength(7)
    )
    .addStringOption((opt) =>
      opt.setName('afbeelding').setDescription('URL van een grote banner-afbeelding onderaan het embed')
    )
    .addStringOption((opt) =>
      opt.setName('thumbnail').setDescription('URL van een kleine afbeelding rechtsboven in het embed')
    )
    .addStringOption((opt) =>
      opt.setName('footer').setDescription('Footer tekst onderaan het embed').setMaxLength(2048)
    )
    .addChannelOption((opt) =>
      opt
        .setName('categorie')
        .setDescription('Standaard categorie waarin nieuwe ticket-kanalen worden aangemaakt')
        .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption((opt) =>
      opt
        .setName('log_kanaal')
        .setDescription('Kanaal waar transcripts en sluit-logs naartoe gestuurd worden')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption((opt) =>
      opt.setName('support_rol').setDescription('Standaard rol die toegang krijgt tot elk ticket')
    )
    .addStringOption((opt) =>
      opt
        .setName('naam_formaat')
        .setDescription('Kanaalnaam-formaat. Placeholders: {number} {user} {type}')
        .setMaxLength(100)
    )
    .addStringOption((opt) =>
      opt
        .setName('welkomstbericht')
        .setDescription('Bericht bovenaan elk nieuw ticket. Placeholders: {user} {type}')
        .setMaxLength(2000)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('max_open_per_gebruiker')
        .setDescription('Max. gelijktijdig open tickets per gebruiker (1-25)')
        .setMinValue(1)
        .setMaxValue(25)
    )
    .addBooleanOption((opt) =>
      opt.setName('ping_support_rol').setDescription('Pingt de support-rol kort bij het openen van een ticket')
    )
    .addBooleanOption((opt) =>
      opt.setName('verplicht_reden').setDescription('Verplicht een reden bij het sluiten van een ticket via /ticket-close')
    )
    .addBooleanOption((opt) =>
      opt.setName('toon_ticket_info').setDescription('Toon het "Ticket Information" blok (categorie/opener/datum) bovenaan elk ticket')
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const fields = {};
    const map = [
      ['titel', 'panelTitle', (v) => v],
      ['beschrijving', 'panelDescription', (v) => v],
      ['kleur', 'panelColor', (v) => v],
      ['afbeelding', 'panelImage', (v) => v],
      ['thumbnail', 'panelThumbnail', (v) => v],
      ['footer', 'panelFooter', (v) => v],
      ['naam_formaat', 'nameFormat', (v) => v],
      ['welkomstbericht', 'welcomeMessage', (v) => v],
      ['max_open_per_gebruiker', 'maxOpenPerUser', (v) => v],
      ['ping_support_rol', 'pingSupportRole', (v) => v],
      ['verplicht_reden', 'requireCloseReason', (v) => v],
      ['toon_ticket_info', 'showTicketInfo', (v) => v],
    ];

    for (const [optName, apiKey, transform] of map) {
      if (interaction.options.get(optName)) {
        const raw = interaction.options.get(optName).value;
        fields[apiKey] = transform(raw);
      }
    }

    const categorie = interaction.options.getChannel('categorie');
    if (categorie) fields.categoryId = categorie.id;

    const logKanaal = interaction.options.getChannel('log_kanaal');
    if (logKanaal) fields.logChannelId = logKanaal.id;

    const supportRol = interaction.options.getRole('support_rol');
    if (supportRol) fields.supportRoleId = supportRol.id;

    if (Object.keys(fields).length === 0) {
      // No changes requested — just show the current config.
      const { config } = await api.getTicketConfig(interaction.guildId);
      await interaction.editReply({ embeds: [buildConfigSummary(config)] });
      return;
    }

    try {
      const { config } = await api.updateTicketConfig(interaction.guildId, fields);
      await interaction.editReply({
        embeds: [
          embeds
            .success('Ticket panel bijgewerkt', 'De instellingen zijn opgeslagen. Gebruik `/ticket-send` om het panel (opnieuw) te versturen.')
            .addFields(buildConfigSummary(config).data.fields || []),
        ],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Instellen mislukt', err.message)] });
    }
  },
};

function buildConfigSummary(config) {
  return embeds
    .custom({
      title: '⚙️ Huidige ticket panel instellingen',
      color: hexToInt(config.panelColor),
      image: config.panelImage,
      thumbnail: config.panelThumbnail,
      footer: config.panelFooter,
      fields: [
        { name: 'Titel', value: config.panelTitle, inline: true },
        { name: 'Kleur', value: `#${config.panelColor}`, inline: true },
        { name: 'Max. open per gebruiker', value: String(config.maxOpenPerUser), inline: true },
        { name: 'Categorie', value: config.categoryId ? `<#${config.categoryId}>` : 'Niet ingesteld', inline: true },
        { name: 'Log kanaal', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Niet ingesteld', inline: true },
        { name: 'Support rol', value: config.supportRoleId ? `<@&${config.supportRoleId}>` : 'Niet ingesteld', inline: true },
        { name: 'Naam formaat', value: `\`${config.nameFormat}\``, inline: true },
        { name: 'Ping support rol', value: config.pingSupportRole ? 'Ja' : 'Nee', inline: true },
        { name: 'Reden verplicht bij sluiten', value: config.requireCloseReason ? 'Ja' : 'Nee', inline: true },
        { name: 'Ticket Information blok', value: config.showTicketInfo ? 'Ja' : 'Nee', inline: true },
        { name: 'Beschrijving', value: config.panelDescription },
        { name: 'Welkomstbericht', value: config.welcomeMessage },
      ],
    })
    .setDescription(null);
}
