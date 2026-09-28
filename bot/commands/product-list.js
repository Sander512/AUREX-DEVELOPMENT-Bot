// bot/commands/product-list.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('product-list')
    .setDescription('[Management] Toon alle producten in de webshop'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { products } = await api.listProducts(interaction.guildId);

      if (products.length === 0) {
        await interaction.editReply({
          embeds: [embeds.info('Nog geen producten', 'Gebruik `/product-add` om je eerste product toe te voegen.')],
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
        embeds: [embeds.info('Webshop producten', `${lines.join('\n')}\n\n🟢 = actief · ⚪ = inactief\n⚠️ = nog geen bestand gekoppeld; gebruik `/product-update` met de optie *bestand*.`)],
      });
    } catch (err) {
      await interaction.editReply({ embeds: [embeds.error('Laden mislukt', err.message)] });
    }
  },
};
