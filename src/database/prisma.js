const { PrismaClient } = require("@prisma/client");

// Single shared Prisma instance for the whole bot process.
const prisma = new PrismaClient();

module.exports = { prisma };
