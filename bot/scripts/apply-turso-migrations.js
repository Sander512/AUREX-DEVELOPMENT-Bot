require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

/**
 * Prisma's `migrate deploy` targets a normal SQLite file, not a remote
 * Turso (libSQL) database — so instead we read the migration SQL files
 * Prisma already generated locally (via `npx prisma migrate dev`, run
 * against a local file:./dev.db) and execute them directly against Turso.
 *
 * Usage: node scripts/apply-turso-migrations.js
 * Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment.
 */
async function main() {
  const migrationsDir = path.join(__dirname, "..", "prisma", "migrations");

  if (!fs.existsSync(migrationsDir)) {
    console.error("Geen prisma/migrations map gevonden. Draai eerst lokaal:");
    console.error("  DATABASE_URL=file:./dev.db npx prisma migrate dev --name init");
    process.exit(1);
  }

  const folders = fs
    .readdirSync(migrationsDir)
    .filter((f) => fs.statSync(path.join(migrationsDir, f)).isDirectory())
    .sort(); // migration folders are timestamp-prefixed, so this is chronological

  if (folders.length === 0) {
    console.error("Geen migraties gevonden in prisma/migrations.");
    process.exit(1);
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  for (const folder of folders) {
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;

    console.log(`Toepassen: ${folder}`);
    const sql = fs.readFileSync(sqlPath, "utf-8");

    // Split on semicolons at end-of-line — good enough for Prisma's
    // generated SQL, which doesn't embed semicolons inside strings here.
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await client.execute(statement);
    }
  }

  console.log("Klaar. Alle migraties zijn toegepast op Turso.");
}

main().catch((err) => {
  console.error("Migratie mislukt:", err);
  process.exit(1);
});
