import Database from "better-sqlite3-multiple-ciphers";

/**
 * Is this file a Lawha backup, or just a file with the right name?
 *
 * THE DRIVER HERE IS THE CIPHER ONE, and that is not a stylistic choice. This
 * module used to link plain `better-sqlite3` while `src/db/index.ts` linked
 * `better-sqlite3-multiple-ciphers`, which put TWO independently linked copies
 * of SQLite in the server process — see the long comment at the top of
 * `src/db/index.ts` for what that cost when measured. It also made a keyed
 * artefact unverifiable: SQLCipher encrypts the header, so the plain driver
 * reads `SQLITE_NOTADB` on the first page of every backup a keyed deployment
 * takes. One driver answers both.
 *
 * The rule is `scripts/backup.mjs`'s rule, and this is deliberately a SECOND
 * COPY of it rather than a shared import. `backup.mjs` cannot be imported: it
 * has no exports and no main guard, so argv parsing, a top-level `await` and
 * `process.exit()` all fire the moment it loads. That is not an oversight —
 * it runs under plain `node` in the runtime image, where `tsx` does not exist
 * and `src/` has not been compiled. Importing it from here would take a backup
 * and then kill the server.
 *
 * `tests/integration/backupVerifyParity.test.ts` reads that script as text and
 * fails if these constants stop matching it. That test is the only thing
 * holding the two copies together — do not delete it, and do not edit the
 * constants below without editing `backup.mjs` in the same commit.
 */

/**
 * The four tables an operator can recognise their own deployment in. `users`
 * matters most: zero accounts is precisely what the disaster looked like, and
 * a backup whose `users` table is missing entirely is not a Lawha database at
 * all.
 */
export const COUNTED_TABLES = [
  "users",
  "boards",
  "board_scenes",
  "files",
] as const;

export type CountedTable = typeof COUNTED_TABLES[number];

/** What `backup.mjs` names the artefacts it ships. */
export const BACKUP_NAME = /^lawha-\d{8}-\d{6}\.db$/;

/**
 * What `backup.mjs` names an artefact it encrypted to `LAWHA_BACKUP_RECIPIENT`.
 * A second, independent copy of the pattern of the same kind `BACKUP_NAME`
 * already is — see the file header — and it exists for the same reason:
 * `backupArchive.ts` uses both to decide what the admin panel is even allowed
 * to list or fetch, and the day `backup.mjs` starts writing `.db.age`
 * artefacts is the day this file has to already know the shape, not the day
 * someone notices the archive panel went quietly empty.
 */
export const AGE_BACKUP_NAME = /^lawha-\d{8}-\d{6}\.db\.age$/;

export interface BackupVerification {
  ok: boolean;
  /** Why it was refused. Absent when `ok`. */
  reason?: string;
  /** Row counts per table. Absent when refused. */
  counts?: Record<CountedTable, number>;
}

const tableExists = (db: Database.Database, name: string): boolean =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;

/**
 * `key='…'` with the passphrase escaped as a SQL string literal — the same
 * function, character for character, as `keyPragma` in `src/db/index.ts`. The
 * doubling is the whole of the safety; that file's comment carries why.
 */
const keyPragma = (key: string): string => `key='${key.replace(/'/g, "''")}'`;

/**
 * Open a candidate read-only and decide whether it is a backup.
 *
 * Read-only because this is called on artefacts that are, or are about to
 * become, the thing an operator restores from — opening one read-write would
 * leave a `-wal` beside it, which is exactly the sidecar the whole backup
 * design exists to avoid shipping. Measured: `readonly` and `PRAGMA key`
 * coexist happily, and no sidecar appears.
 *
 * `key` is `LAWHA_DB_KEY`, or null for a deployment that has not opted in. It
 * is STRICT in both directions on purpose — the key must open the artefact,
 * and a null key must not open an encrypted one — because the only caller is
 * `backupSnapshot.ts` verifying a copy it has just made, where "we meant to
 * write ciphertext and wrote plaintext" is precisely the failure that must not
 * pass. (`scripts/backup.mjs`'s retention is deliberately more forgiving, and
 * says why: it is judging artefacts from before the key existed.)
 *
 * Never throws. A file that is not a database, a file that has been truncated,
 * a path that vanished between the caller's check and this open — all of them
 * are "no, and here is why", because every caller's next move is the same
 * either way: refuse the artefact and say so.
 */
export const verifyBackupFile = (
  filePath: string,
  key: string | null = null,
): BackupVerification => {
  let db: Database.Database | undefined;

  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });

    if (key !== null) {
      // DO NOT REORDER. `cipher` selects the scheme and `key` is interpreted
      // by whichever scheme is selected at the moment it is set; this driver's
      // default is chacha20, not sqlcipher. `src/db/index.ts` carries the full
      // version of this warning.
      db.pragma("cipher=sqlcipher");
      db.pragma(keyPragma(key));
    }

    // Before anything else, and it is not ceremony: SQLCipher answers `ok` to
    // `PRAGMA key` for any key at all, right or wrong, because it has not read
    // a page yet. Without this read a wrong key would surface as a confusing
    // failure inside `integrity_check` instead of as "not a backup" — and a
    // key that is simply ignored would look like success.
    db.prepare("SELECT count(*) FROM sqlite_master").get();

    const integrity = (
      db.pragma("integrity_check") as Array<{ integrity_check: string }>
    )[0]?.integrity_check;

    if (integrity !== "ok") {
      return {
        ok: false,
        reason: `integrity_check said "${integrity}", not "ok"`,
      };
    }

    const missing = COUNTED_TABLES.filter((table) => !tableExists(db!, table));

    if (missing.length > 0) {
      return {
        ok: false,
        reason: `not a Lawha database: missing ${missing.join(", ")}`,
      };
    }

    const counts = Object.fromEntries(
      COUNTED_TABLES.map((table) => [
        table,
        (
          db!.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ]),
    ) as Record<CountedTable, number>;

    // Zero accounts is NOT a failure. `backup.mjs` warns and ships it, because
    // a deployment nobody has signed up to yet must still be able to back up.
    return { ok: true, counts };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not be opened",
    };
  } finally {
    db?.close();
  }
};
