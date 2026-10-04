// bot/commands/giveaway.js
// Eén command voor alle giveaways: starten, beëindigen, opnieuw trekken en
// lijst tonen. (Zelfde systeem als bij Forever, maar samengevoegd tot
// één /giveaway zoals /product.)
//
// "start" opent een formulier (Duur, Aantal winnaars, Prijs, Omschrijving)
// zoals GiveawayBot. Kanaal en vereiste rol blijven slash-opties, omdat een
// formulier geen kanaal- of rolkiezer kan bevatten.

const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const api = require('../utils/api');
const embeds = require('../utils/embeds');
const { pickWinners, formatWinners, drawGiveaway } = require('../utils/giveaways');
const { buildGiveawayModal } = require('../handlers/giveawayInteractions');

async function autocompleteGiveaway(interaction, status) {
  const focused = String(interaction.options.getFocused()).toLowerCase();
  try {
    const { giveaways } = await api.listGuildGiveaways(interaction.guildId, status);
    const choices = giveaways
      .filter((g) => g.prize.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((g) => {
        const label =
          status === 'active'
            ? `${g.prize} — eindigt over ${formatShort(g.endsAt - Date.now())}`
            : `${g.prize} — geëindigd`;
        return { name: label.slice(0, 100), value: g.id };
      });
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}

// Discord toont <t:..:R> niet in autocomplete-labels, dus zelf formatteren.
function formatShort(ms) {
  if (ms <= 0) return 'zo';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}u`;
  return `${Math.round(hours / 24)}d`;
}

async function subStart(interaction) {
  const channel = interaction.options.getChannel('kanaal') ?? interaction.channel;
  const requiredRole = interaction.options.getRole('vereiste_rol');

  // showModal() moet het ALLEREERSTE antwoord op de interactie zijn —
  // dus géén defer/reply hiervoor.
  await interaction.showModal(buildGiveawayModal(channel.id, requiredRole?.id || null));
}

async function subEnd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getInteger('giveaway', true);

  try {
    const { giveaway } = await api.getGiveaway(id);
    if (!giveaway || giveaway.guildId !== interaction.guildId) {
      await interaction.editReply({ embeds: [embeds.error('Niet gevonden', 'Deze giveaway bestaat niet (meer) in deze server.')] });
      return;
    }
    if (giveaway.status !== 'active') {
      await interaction.editReply({ embeds: [embeds.error('Al beëindigd', 'Deze giveaway is al afgelopen.')] });
      return;
    }

    const result = await drawGiveaway({ client: interaction.client, giveaway, api });
    if (result.cancelled) {
      await interaction.editReply({ embeds: [embeds.error('Kon niet beëindigen', result.reason)] });
      return;
    }

    await interaction.editReply({
      embeds: [
        embeds.success(
          'Giveaway beëindigd',
          `Winnaar(s): ${result.winners.length ? result.winners.map((w) => `<@${w}>`).join(', ') : 'niemand deed mee'}`
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Beëindigen mislukt', err.message)] });
  }
}

async function subReroll(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getInteger('giveaway', true);
  const count = interaction.options.getInteger('aantal');

  try {
    const { giveaway } = await api.getGiveaway(id);
    if (!giveaway || giveaway.guildId !== interaction.guildId) {
      await interaction.editReply({ embeds: [embeds.error('Niet gevonden', 'Deze giveaway bestaat niet (meer) in deze server.')] });
      return;
    }
    if (giveaway.status !== 'ended') {
      await interaction.editReply({ embeds: [embeds.error('Nog niet afgelopen', 'Alleen een afgelopen giveaway kan opnieuw getrokken worden.')] });
      return;
    }

    const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) {
      await interaction.editReply({ embeds: [embeds.error('Kon niet opnieuw trekken', 'Het oorspronkelijke kanaal is niet meer te vinden.')] });
      return;
    }

    let pool = giveaway.entries || [];
    if (giveaway.requiredRoleId) {
      const members = pool.length ? await channel.guild.members.fetch({ user: pool }).catch(() => new Map()) : new Map();
      pool = pool.filter((uid) => members.get(uid)?.roles.cache.has(giveaway.requiredRoleId));
    }

    const winners = pickWinners(pool, count ?? giveaway.winnerCount);

    // De API weigert een lege lijst bij reroll; dan is er niets te melden.
    if (winners.length === 0) {
      await interaction.editReply({ embeds: [embeds.error('Geen geldige deelnemers', 'Er zijn geen deelnemers om uit te trekken.')] });
      return;
    }

    await api.rerollGiveaway(id, winners);

    await channel.send({
      content: winners.map((w) => `<@${w}>`).join(', '),
      embeds: [
        embeds.custom({
          title: '🔁 Giveaway opnieuw getrokken',
          description: `Nieuwe winnaar(s) voor **${giveaway.prize}**: ${formatWinners(winners)}`,
          color: 0x10b981,
        }),
      ],
    });

    await interaction.editReply({
      embeds: [embeds.success('Opnieuw getrokken', `Nieuwe winnaar(s): ${winners.map((w) => `<@${w}>`).join(', ')}`)],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Opnieuw trekken mislukt', err.message)] });
  }
}

async function subList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { giveaways } = await api.listGuildGiveaways(interaction.guildId, 'active');

    if (giveaways.length === 0) {
      await interaction.editReply({ embeds: [embeds.info('Geen lopende giveaways', 'Er zijn momenteel geen actieve giveaways in deze server.')] });
      return;
    }

    const description = giveaways
      .map(
        (g) =>
          `**${g.prize}** — ${g.entryCount ?? 0} deelnemer(s), ${g.winnerCount} winnaar(s), eindigt <t:${Math.floor(g.endsAt / 1000)}:R> (host: <@${g.hostId}>)`
      )
      .join('\n')
      .slice(0, 4000);

    await interaction.editReply({ embeds: [embeds.info(`Lopende giveaways (${giveaways.length})`, description)] });
  } catch (err) {
    await interaction.editReply({ embeds: [embeds.error('Ophalen mislukt', err.message)] });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('[Management] Beheer giveaways')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Maak een giveaway aan')
        .addChannelOption((opt) =>
          opt.setName('kanaal').setDescription('Kanaal om de giveaway in te posten (standaard dit kanaal)').addChannelTypes(ChannelType.GuildText)
        )
        .addRoleOption((opt) => opt.setName('vereiste_rol').setDescription('Alleen leden met deze rol kunnen meedoen en winnen'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('Beëindig een lopende giveaway direct en trek winnaars')
        .addIntegerOption((opt) => opt.setName('giveaway').setDescription('Welke giveaway?').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Trek nieuwe winnaar(s) voor een afgelopen giveaway')
        .addIntegerOption((opt) => opt.setName('giveaway').setDescription('Welke giveaway?').setRequired(true).setAutocomplete(true))
        .addIntegerOption((opt) =>
          opt.setName('aantal').setDescription('Aantal nieuwe winnaars (standaard hetzelfde als origineel)').setMinValue(1).setMaxValue(50)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Bekijk lopende giveaways in deze server')),

  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'end') return autocompleteGiveaway(interaction, 'active');
    if (sub === 'reroll') return autocompleteGiveaway(interaction, 'ended');
    return interaction.respond([]);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return subStart(interaction);
    if (sub === 'end') return subEnd(interaction);
    if (sub === 'reroll') return subReroll(interaction);
    if (sub === 'list') return subList(interaction);
  },
};
