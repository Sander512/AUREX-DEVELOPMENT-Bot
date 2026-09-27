const { prisma } = require("./prisma");
const { getGuildMember, getGuild } = require("./discord");
const { parseJson } = require("./json");

// Fallback permissions used until an owner configures the matrix in the
// dashboard itself (Settings > Staff). Real per-guild overrides live in
// StaffPermission.permissions and always win over this.
const DEFAULT_PERMISSIONS = {
  OWNER: { all: true },
  CO_OWNER: { all: true },
  MANAGEMENT: { manageProducts: true, manageOrders: true, manageTickets: true, manageSettings: true, viewCustomers: true },
  HEAD_DEVELOPER: { manageProducts: true, manageOrders: true, viewCustomers: true },
  DEVELOPER: { manageProducts: true, viewCustomers: true },
  JUNIOR_DEVELOPER: { viewCustomers: true },
  SUPPORT_MANAGER: { manageTickets: true, manageOrders: true, viewCustomers: true },
  SUPPORT: { manageTickets: true, viewCustomers: true },
  DESIGNER: {},
};

/**
 * Resolves what a logged-in Discord user is allowed to do in a given guild's
 * dashboard. Returns null if they have no staff access at all (customers get
 * null here — the dashboard's management UI simply isn't for them).
 */
async function resolveAccess(guildId, discordUserId) {
  const [member, guild, staffPermissions] = await Promise.all([
    getGuildMember(guildId, discordUserId),
    getGuild(guildId),
    prisma.staffPermission.findMany({ where: { guildId } }),
  ]);

  if (!member) return null; // not even in the server

  // The Discord server owner always has full (OWNER-equivalent) access,
  // even before any StaffPermission rows exist.
  if (guild && guild.owner_id === discordUserId) {
    return { role: "OWNER", permissions: { all: true } };
  }

  const memberRoleIds = new Set(member.roles || []);
  const matches = staffPermissions.filter((sp) => sp.discordRoleId && memberRoleIds.has(sp.discordRoleId));

  if (matches.length === 0) return null; // in the server, but no staff role

  // If someone holds multiple staff roles, merge permissions (most-permissive wins).
  const merged = {};
  let highestRole = null;
  const ROLE_ORDER = [
    "OWNER", "CO_OWNER", "MANAGEMENT", "HEAD_DEVELOPER", "DEVELOPER",
    "JUNIOR_DEVELOPER", "SUPPORT_MANAGER", "SUPPORT", "DESIGNER",
  ];

  for (const sp of matches) {
    const perms = { ...DEFAULT_PERMISSIONS[sp.role], ...parseJson(sp.permissions, {}) };
    Object.assign(merged, perms);
    if (highestRole === null || ROLE_ORDER.indexOf(sp.role) < ROLE_ORDER.indexOf(highestRole)) {
      highestRole = sp.role;
    }
  }

  return { role: highestRole, permissions: merged };
}

function canDo(access, capability) {
  if (!access) return false;
  return !!(access.permissions.all || access.permissions[capability]);
}

module.exports = { resolveAccess, canDo, DEFAULT_PERMISSIONS };
