// bot/commands/8ball.js
// Pure Discord command — geen koppeling met de API nodig, gewoon voor de lol.

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../utils/embeds');

const ANSWERS = [
  'Zeker weten.',
  'Ja, absoluut.',
  'Zonder twijfel.',
  'Ja.',
  'Waarschijnlijk wel.',
  'Vraag het later nog eens.',
  'Kan ik nu niet zeggen.',
  'Concentreer je en vraag opnieuw.',
  'Reken er niet op.',
  'Mijn antwoord is nee.',
  'Ziet er niet goed uit.',
  'Zeer twijfelachtig.',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Stel de magische 8-ball een vraag')
    .addStringOption((opt) =>
      opt.setName('vraag').setDescription('Je vraag').setRequired(true)
    ),

  async execute(interaction) {
    const question = interaction.options.getString('vraag', true);
    const answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];

    await interaction.reply({
      embeds: [embeds.info('🎱 Magische 8-ball', `**Vraag:** ${question}\n**Antwoord:** ${answer}`)],
    });
  },
};
