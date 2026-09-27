const DiscordProvider = require("next-auth/providers/discord").default;

const authOptions = {
  providers: [
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      authorization: { params: { scope: "identify guilds" } },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Persist the Discord user id on the token/session so pages and API
    // routes can resolve staff access without re-parsing the OAuth profile.
    async jwt({ token, profile }) {
      if (profile) {
        token.discordId = profile.id;
      }
      return token;
    },
    async session({ session, token }) {
      session.discordId = token.discordId;
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  // Render only reveals a service's public URL after the first deploy, and
  // auto-injects it as RENDER_EXTERNAL_URL from then on — so NextAuth works
  // out of the box on Render without hand-copying the URL into NEXTAUTH_URL.
  // (NEXTAUTH_URL still wins if you set it explicitly, e.g. a custom domain.)
};

if (!process.env.NEXTAUTH_URL && process.env.RENDER_EXTERNAL_URL) {
  process.env.NEXTAUTH_URL = process.env.RENDER_EXTERNAL_URL;
}

module.exports = { authOptions };
