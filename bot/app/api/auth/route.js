const NextAuth = require("next-auth").default;
const { authOptions } = require("../../../../lib/auth");

const handler = NextAuth(authOptions);

module.exports = { GET: handler, POST: handler };
