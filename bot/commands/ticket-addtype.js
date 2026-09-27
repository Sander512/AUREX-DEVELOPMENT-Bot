// bot/commands/ticket-addtype.js
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-addtype')
    .setDescription('[Management] Voeg een ticket-type (optie in het panel) toe')
    .addStringOption((opt) =>
      opt.setName('label').setDescription('Naam zoals getoond in het panel, bv. "Algemene vraag"').setRequired(true).setMaxLength(80)
    )
    .addStringOption((opt) =>
      opt.setName('emoji').setDescription('Emoji voor deze optie, bv. 🎫').setMaxLength(100)
    )
    .addStringOption((opt) =>
      opt.setName('beschrijving').setDescription('Korte beschrijving onder het label in het panel').setMaxLength(100)
    )
    .addStringOption((opt) =>
      opt.setName('key').setDescription('Interne unieke ID (a-z, 0-9, -, _). Wordt automatisch gegenereerd indien leeg').setMaxLength(32)
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
    .addBooleanOption((opt) =>
      opt.setName('claim_knop').setDescription('Toon de "Claim" knop in tickets van dit type (standaard: aan)')
    )
    .addBooleanOption((opt) =>
      opt.setName('sluit_knop').setDescription('Toon de "Sluiten" knop in tickets van dit type (standaard: aan)')
    )
    .addBooleanOption((opt) =>
      opt.setName('vraag_beschrijving').setDescription('Vraag de gebruiker om een beschrijving bij het openen (standaard: aan)')
    )
    .addIntegerOption((opt) =>
      opt
        .setName('max_open')
        .setDescription('Overschrijft max. gelijktijdig open tickets van dit type per gebruiker (1-25)')
        .setMinValue(1)
        .setMaxValue(25)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const type = {
      label: interaction.options.getString('label', true),
      emoji: interaction.options.getString('emoji') || undefined,
      description: interaction.options.getString('beschrijving') || undefined,
      key: interaction.options.getString('key') || undefined,
      categoryId: interaction.options.getChannel('categorie')?.id,
      supportRoleId: interaction.options.getRole('rol')?.id,
      nameFormat: interaction.options.getString('naam_formaat') || undefined,
      welcomeMessage: interaction.options.getString('welkomstbericht') || undefined,
      claimEnabled: interaction.options.get('claim_knop') ? interaction.options.getBoolean('claim_knop') : undefined,
      closeEnabled: interaction.options.get('sluit_knop') ? interaction.options.getBoolean('sluit_knop') : undefined,
      askDescription: interaction.options.get('vraag_beschrijving') ? interaction.options.getBoolean('vraag_beschrijving') : undefined,
      maxOpenOverride: interaction.options.getInteger('max_open') || undefined,
    };

    try {
      const { type: created } = await api.addTicketType(interaction.guildId, type);
      await interaction.editReply({
        embeds: [
          embeds.success(
            'Ticket type toegevoegd',
            `${created.emoji ? `${created.emoji} ` : ''}**${created.label}** (\`${type.key || created.key}\`) staat nu in het panel.\nGebruik \`/ticket-send\` om het bijgewerkte panel te versturen.`
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Toevoegen mislukt', err.message)] });
    }
  },
};
