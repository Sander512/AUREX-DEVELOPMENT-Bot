// bot/commands/coinflip.js
const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Gooi een muntje op'),

  async execute(interaction) {
    const result = Math.random() < 0.5 ? 'Kop 🪙' : 'Munt 🪙';
    await interaction.reply({ embeds: [embeds.info('Muntje gooien', `Het is... **${result}**!`)] });
  },
};
