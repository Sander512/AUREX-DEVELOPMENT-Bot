// bot/commands/ticket-edittype.js
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-edittype')
    .setDescription('[Management] Wijzig een bestaand ticket-type')
    .addStringOption((opt) =>
      opt.setName('key').setDescription('De key van het type dat je wilt wijzigen (zie /ticket-listtypes)').setRequired(true).setMaxLength(32)
    )
    .addStringOption((opt) => opt.setName('label').setDescription('Nieuwe naam zoals getoond in het panel').setMaxLength(80))
    .addStringOption((opt) => opt.setName('emoji').setDescription('Nieuwe emoji voor deze optie').setMaxLength(100))
    .addStringOption((opt) =>
      opt.setName('beschrijving').setDescription('Nieuwe korte beschrijving onder het label in het panel').setMaxLength(100)
    )
    .addChannelOption((opt) =>
      opt.setName('categorie').setDescription('Overschrijft de standaardcategorie voor dit type').addChannelTypes(ChannelType.GuildCategory)
    )
    .addRoleOption((opt) => opt.setName('rol').setDescription('Overschrijft de standaard support-rol voor dit type'))
    .addStringOption((opt) =>
      opt.setName('naam_formaat').setDescription('Overschrijft het kanaalnaam-formaat voor dit type').setMaxLength(100)
    )
    .addStringOption((opt) =>
      opt.setName('welkomstbericht').setDescription('Overschrijft het welkomstbericht voor dit type').setMaxLength(2000)
    )
    .addBooleanOption((opt) => opt.setName('claim_knop').setDescription('Toon de "Claim" knop in tickets van dit type'))
    .addBooleanOption((opt) => opt.setName('sluit_knop').setDescription('Toon de "Sluiten" knop in tickets van dit type'))
    .addBooleanOption((opt) =>
      opt.setName('vraag_beschrijving').setDescription('Vraag de gebruiker om een beschrijving bij het openen')
    )
    .addIntegerOption((opt) =>
      opt
        .setName('max_open')
        .setDescription('Max. open tickets van dit type per gebruiker (1-25). 0 = override verwijderen')
        .setMinValue(0)
        .setMaxValue(25)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const key = interaction.options.getString('key', true);
    const fields = {};

    const label = interaction.options.getString('label');
    if (label !== null) fields.label = label;

    const emoji = interaction.options.getString('emoji');
    if (emoji !== null) fields.emoji = emoji;

    const beschrijving = interaction.options.getString('beschrijving');
    if (beschrijving !== null) fields.description = beschrijving;

    const categorie = interaction.options.getChannel('categorie');
    if (categorie) fields.categoryId = categorie.id;

    const rol = interaction.options.getRole('rol');
    if (rol) fields.supportRoleId = rol.id;

    const naamFormaat = interaction.options.getString('naam_formaat');
    if (naamFormaat !== null) fields.nameFormat = naamFormaat;

    const welkomstbericht = interaction.options.getString('welkomstbericht');
    if (welkomstbericht !== null) fields.welcomeMessage = welkomstbericht;

    if (interaction.options.get('claim_knop')) fields.claimEnabled = interaction.options.getBoolean('claim_knop');
    if (interaction.options.get('sluit_knop')) fields.closeEnabled = interaction.options.getBoolean('sluit_knop');
    if (interaction.options.get('vraag_beschrijving')) fields.askDescription = interaction.options.getBoolean('vraag_beschrijving');

    const maxOpen = interaction.options.getInteger('max_open');
    if (maxOpen !== null) fields.maxOpenOverride = maxOpen === 0 ? null : maxOpen;

    if (Object.keys(fields).length === 0) {
      await interaction.editReply({ embeds: [embeds.warning('Niets om te wijzigen', 'Geef minstens één veld op om te wijzigen.')] });
      return;
    }

    try {
      const { type } = await api.updateTicketType(interaction.guildId, key, fields);
      await interaction.editReply({
        embeds: [
          embeds.success(
            'Ticket type bijgewerkt',
            `${type.emoji ? `${type.emoji} ` : ''}**${type.label}** (\`${type.key}\`) is bijgewerkt.\nGebruik \`/ticket-send\` om het panel opnieuw te versturen als het label/emoji is veranderd.`
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Wijzigen mislukt', err.message)] });
    }
  },
};
