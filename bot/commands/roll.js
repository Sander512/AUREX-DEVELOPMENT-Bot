// bot/commands/roll.js
const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Gooi een dobbelsteen')
    .addIntegerOption((opt) =>
      opt.setName('zijden').setDescription('Aantal zijden (standaard 6)').setRequired(false).setMinValue(2).setMaxValue(1000)
    ),

  async execute(interaction) {
    const sides = interaction.options.getInteger('zijden') || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    await interaction.reply({ embeds: [embeds.info('🎲 Dobbelsteen', `Je gooide een **${result}** (van de ${sides})!`)] });
  },
};
