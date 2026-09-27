const { cookies } = require("next/headers");
const { getSessionUser } = require("../lib/session");

module.exports = async function HomePage() {
  const session = getSessionUser(cookies());

  if (session) {
    // Guild-picking happens via the bot's /dashboard command, which already
    // knows which guild the user ran it from. A logged-in visit to "/" with
    // no guild in the URL just confirms login succeeded.
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "1.5rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <div>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.25rem", letterSpacing: "0.05em" }}>
          AUREX DEVELOPMENT
        </h1>
        <p style={{ color: "#999", marginTop: 0 }}>Deserve All Right.</p>
      </div>

      {session ? (
        <p style={{ color: "#c9a227" }}>
          Ingelogd als {session.username}. Gebruik <code>/dashboard</code> in Discord om een server te openen.
        </p>
      ) : (
        <a
          href="/api/auth/discord"
          style={{
            background: "#c9a227",
            color: "#0b0b0d",
            padding: "0.75rem 1.5rem",
            borderRadius: "8px",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Inloggen met Discord
        </a>
      )}
    </main>
  );
};
