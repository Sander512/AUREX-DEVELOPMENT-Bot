/**
 * Turso (SQLite) stores what would be array/JSON columns in Postgres as
 * plain String columns instead. These two helpers keep that conversion in
 * one place instead of sprinkling JSON.parse/stringify everywhere.
 */

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJsonString(value) {
  return JSON.stringify(value ?? null);
}

module.exports = { parseJson, toJsonString };
