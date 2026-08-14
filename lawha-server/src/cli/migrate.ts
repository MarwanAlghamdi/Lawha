import { loadConfig } from "../config.js";
import { openDatabase, runMigrations } from "../db/index.js";

/**
 * `yarn --cwd lawha-server migrate`.
 *
 * A file of its own, and that is the whole point of it. The same six lines used
 * to sit at the bottom of `src/db/migrate.ts` behind an
 * `import.meta.url === process.argv[1]` guard, reaching for `openDatabase` with
 * a top-level `await import("./index.js")` — and `db/index.ts` imports
 * `runMigrations` from `db/migrate.ts`. That is a cycle with a top-level await
 * across it, so `index.js` waited for `migrate.js` to finish evaluating while
 * `migrate.js` awaited `index.js`. Node exits 13, prints "Detected unsettled
 * top-level await", and applies nothing.
 *
 * Nothing failed loudly: the command simply never worked, and migrations run
 * on boot anyway, so no deployment ever noticed. A leaf module imports both
 * statically and there is no cycle to deadlock.
 */
const config = loadConfig();
const db = openDatabase({
  path: config.dbPath,
  key: config.dbKey,
  migrate: false,
});
const count = runMigrations(db);

process.stdout.write(
  `lawha: applied ${count} migration(s) to ${config.dbPath}\n`,
);
db.close();
