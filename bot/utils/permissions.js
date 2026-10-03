// bot/utils/permissions.js
// Centralized permission checking for all slash commands.
//
// Rules:
//  - Administrator (Discord permission) always has access to everything.
//  - Management role has access to everything in MANAGEMENT_COMMANDS.
//  - Staff role only has access to commands explicitly listed in STAFF_COMMANDS.

const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// Commands management is allowed to run.
const MANAGEMENT_COMMANDS = new Set([
  'ban',
  'unban',
  'kick',
  'announce',
  'shutdown',
  'unverify',
  'ticket-setup',
  'ticket-addtype',
  'ticket-edittype',
  'ticket-removetype',
  'ticket-listtypes',
  'ticket-send',
  'welcome-test',
  'verify-panel',
  'rules-send',
  'product',
  'security',
]);

// Commands staff are explicitly allowed to run.
// Edit this list to grant staff access to specific commands.
const STAFF_COMMANDS = new Set([
  'userinfo',
  'checkverify',
  'ticket-claim',
  'ticket-close',
  'ticket-add',
  'ticket-remove',
  'ticket-list',
]);

// Commands anyone (verified guild member) may run.
const PUBLIC_COMMANDS = new Set(['userinfo', '8ball', 'coinflip', 'roll']);

function isAdministrator(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function hasRole(interaction, roleId) {
  if (!roleId) return false;
  return interaction.member?.roles?.cache?.has(roleId) ?? false;
}

function isManagement(interaction) {
  return isAdministrator(interaction) || hasRole(interaction, config.roles.managementRoleId);
}

function isStaff(interaction) {
  return isManagement(interaction) || hasRole(interaction, config.roles.staffRoleId);
}

/**
 * Determine whether the interaction's user may run the given command name.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} commandName
 * @returns {boolean}
 */
function canRunCommand(interaction, commandName) {
  if (isAdministrator(interaction)) return true;

  if (PUBLIC_COMMANDS.has(commandName)) return true;

  if (MANAGEMENT_COMMANDS.has(commandName)) {
    return isManagement(interaction);
  }

  if (STAFF_COMMANDS.has(commandName)) {
    return isStaff(interaction);
  }

  // Unknown command — default deny.
  return false;
}

module.exports = {
  canRunCommand,
  isAdministrator,
  isManagement,
  isStaff,
  MANAGEMENT_COMMANDS,
  STAFF_COMMANDS,
  PUBLIC_COMMANDS,
};
