import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The cipher driver's handle, not `better-sqlite3`'s, because that is what
// `openDatabase` hands this. The two are close enough that the old annotation
// still compiled — the cipher `Database` is the plain one plus `key`/`rekey`,
// so it is assignable — which is precisely why it needs saying: an annotation
// that happens to fit is not an annotation that is true, and the day these
// typings diverge should be the day this line stops compiling.
//
// A type-only import, so it adds no runtime edge to the cycle the header of
// `src/cli/migrate.ts` describes at length.
import type { Database } from "better-sqlite3-multiple-ciphers";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const RE_MIGRATION = /^(\d+)_.+\.sql$/;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const readMigrations = (dir = MIGRATIONS_DIR): Migration[] =>
  fs
    .readdirSync(dir)
    .map((name) => {
      const match = name.match(RE_MIGRATION);
      return match
        ? {
            version: Number(match[1]),
            name,
            sql: fs.readFileSync(path.join(dir, name), "utf8"),
          }
        : null;
    })
    .filter((migration): migration is Migration => migration !== null)
    .sort((a, b) => a.version - b.version);

/**
 * Applies any migrations the database has not seen, each in its own
 * transaction. Idempotent, so it is safe to call on every boot.
 */
export const runMigrations = (db: Database, dir = MIGRATIONS_DIR): number => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  let count = 0;

  for (const migration of readMigrations(dir)) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    })();
    count += 1;
  }

  return count;
};

// The CLI that used to live here is `src/cli/migrate.ts` now, and it moved
// because it never ran. It reached `openDatabase` through a top-level
// `await import("./index.js")` — and `db/index.ts` imports `runMigrations` from
// this file, so that is a cycle with a top-level await across it: `index.js`
// waits for this module to finish evaluating, this module awaits `index.js`,
// and Node exits 13 with "Detected unsettled top-level await" having applied
// nothing. Migrations also run on boot, so the broken command was invisible.
