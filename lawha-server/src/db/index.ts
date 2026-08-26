import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

import { runMigrations } from "./migrate.js";

/**
 * ONE SQLITE LIBRARY IS LINKED INTO THIS PROCESS, AND IT MUST STAY THAT WAY.
 *
 * This module links `better-sqlite3-multiple-ciphers` (SQLite 3.53.2), and so
 * — since Task 7B — do `lib/backupSnapshot.ts` and `lib/backupVerify.ts`, the
 * two modules `http/routes/adminBackup.ts` reaches. Both used to link plain
 * `better-sqlite3` (SQLite 3.47.0). Two independently linked copies of SQLite
 * do not see each other's locks: the WAL protocol assumes one library
 * arbitrating every connection to a file, and that assumption was false here.
 *
 * Measured while both were linked: with the encrypted connection open and 3 MB
 * sitting in the `-wal`, an IN-PROCESS `new (plain Database)(livePath)` threw
 * `SQLITE_NOTADB` and, on the way out, checkpointed the WAL away and deleted
 * BOTH sidecars underneath the live connection:
 *
 *   before: main 4096 · -wal 3003512 · -shm 32768
 *   after:  main 217088 · -wal absent · -shm absent
 *
 * It was latent rather than live — the two plain call sites only ever opened
 * SNAPSHOT and ARCHIVE files, never `lawha.db` — but it was one call site away
 * from being real, which is why removing the second library was worth doing
 * rather than documenting further.
 *
 * `scripts/backup.mjs` and `scripts/restore.mjs` still open the live database
 * with whichever driver its bytes call for, and that is safe for a different
 * reason: they run in a SEPARATE PROCESS (`backup.mjs` in the `lawha-backup`
 * container, `restore.mjs` by hand on the host), where SQLite's cross-process
 * locking does apply. Re-run that way, every file was byte-identical.
 *
 * Do not add a third caller that passes `ctx.config.dbPath` to `backupTar.ts`.
 * This is load-bearing: importing plain `better-sqlite3` anywhere under `src/`
 * re-creates the hazard, and an in-process plain open of the live database does
 * not merely fail — it destroys the sidecars of the connection that is serving
 * traffic.
 */

export type LawhaDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  migrate?: boolean;
  /**
   * `LAWHA_DB_KEY`, or null for a plain unencrypted database — which is the
   * default and what every deployment that has not opted in is running.
   */
  key?: string | null;
}

/**
 * The first sixteen bytes of every unencrypted SQLite file. SQLCipher encrypts
 * the header along with everything else, so this is what tells the two apart
 * from the outside, without a key and without opening anything.
 *
 * The sixteenth byte is a NUL and it is written `\0` rather than pasted in
 * literally. A raw NUL in the source compiles and passes its tests perfectly
 * well — and makes git call the file binary, so the diff of this module stops
 * being reviewable. That is how it was found here.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Thrown when the database cannot be read at all — the wrong key, no key
 * against an encrypted file, a key against a plaintext one, or a file that is
 * simply damaged. Its own class because the boot failure it represents is the
 * point of this whole half of the feature, and because "recognisable" is the
 * difference between a caller handling it and a caller matching on a string.
 */
export class DatabaseOpenError extends Error {
  override readonly name = "DatabaseOpenError";
}

/**
 * `key='…'` with the passphrase escaped as a SQL string literal.
 *
 * better-sqlite3's `pragma()` takes a string and has nowhere to bind a
 * parameter, so the key is interpolated and the doubling below is the whole of
 * the safety. A key containing a `'` would otherwise terminate the literal
 * early: SQLCipher would derive from a truncated passphrase, the database would
 * open, and the operator would have an encrypted database whose real key is a
 * prefix of the one they wrote down. That is a silent failure with no way back.
 */
const keyPragma = (key: string): string => `key='${key.replace(/'/g, "''")}'`;

/**
 * Reads the database once, immediately, so that a key mismatch surfaces HERE
 * rather than three lines down as a raw `SQLITE_NOTADB` out of a `journal_mode`
 * pragma.
 *
 * SQLCipher does not validate a key when it is set — `PRAGMA key` returns `ok`
 * for any value, correct or not — because it has not read a page yet. The first
 * statement that touches a page is what fails. So the check has to be a
 * deliberate read, and it has to come before anything else, or the error the
 * operator sees is about journalling.
 *
 * **The `try` is around this probe and nothing else.** `new Database()` above
 * is deliberately left bare, and the `catch` here has exactly one exit — a
 * `throw`. Neither may be weakened: the spec's entire Half B rests on a wrong
 * key KILLING the boot, because a boot that continues finds an empty database,
 * seeds a first-boot administrator, prints a fresh password and looks exactly
 * like the data having been wiped while it sits intact on disk.
 */
const assertDatabaseOpens = (
  db: LawhaDatabase,
  dbPath: string,
  key: string | null,
): void => {
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return;
  } catch (cause) {
    // Built before the handle is closed, and it never reads the key itself:
    // this message reaches stdout, `docker compose logs`, and whatever the
    // operator pastes into a chat window while asking for help.
    const error = new DatabaseOpenError(describeFailure(dbPath, key), {
      cause,
    });
    db.close();
    throw error;
  }
};

/**
 * Refusing to start, spelled out. Appended to three of the four messages below
 * — every one where the data is intact and continuing would hide that.
 *
 * It is worth the repetition because the operator's next action depends on it:
 * a server that stops has done nothing, and a server that carries on has
 * already created an account and printed a password by the time anybody reads
 * the log.
 */
const REFUSING =
  "       Refusing to start: continuing would present an EMPTY database,\n" +
  "       seed a new administrator and print a new password — which looks\n" +
  "       exactly like the data having been wiped.";

/**
 * Which of the four ways this can go wrong actually happened, decided by
 * looking at the file rather than by guessing from the SQLite error. All four
 * arrive as the same `SQLITE_NOTADB`, "file is not a database".
 *
 * That sentence is the wrong thing to put in front of somebody at 3am: it reads
 * as corruption, and the reflex corruption invites is restoring a backup over
 * the top of data that was never damaged. So each branch says which mistake
 * this is, which file it is about, and — where it is true — that the contents
 * are still there.
 */
const describeFailure = (dbPath: string, key: string | null): string => {
  const header = `lawha: cannot open ${dbPath}.\n`;
  const looksPlaintext = readsAsPlaintextSqlite(dbPath);

  if (looksPlaintext && key === null) {
    // The one case that is NOT about the key, and saying so is the useful
    // part: this is a plain SQLite file with the right magic that still will
    // not read. Sending someone hunting for a key they never set would waste
    // the hour in which a backup is the actual answer.
    return (
      `${header}` +
      "       It IS a plain SQLite file and LAWHA_DB_KEY is not set, so this is\n" +
      "       not an encryption problem — the file itself will not read.\n" +
      "       Nothing has been changed. Restore the most recent backup.\n" +
      REFUSING
    );
  }

  if (looksPlaintext) {
    return (
      `${header}` +
      "       LAWHA_DB_KEY is set, but this file is NOT encrypted — it is a\n" +
      "       plain SQLite database. Nothing is wrong with it and nothing here\n" +
      "       has changed it. Either unset LAWHA_DB_KEY, or encrypt the\n" +
      "       database first and start again.\n" +
      REFUSING
    );
  }

  if (key === null) {
    // Two readings, and the bytes cannot tell them apart: an encrypted file
    // and a plain file with a damaged header are both "not the magic".
    //
    // The earlier version of this branch asserted the first — "it looks
    // encrypted, set LAWHA_DB_KEY to the key it was encrypted with" — which
    // is exactly the wrong advice for the deployment that exists TODAY, where
    // LAWHA_DB_KEY has never been set and never encrypted anything. It would
    // send the operator hunting for a key that has never existed, which is the
    // same hour-wasting the branch above was written to prevent.
    return (
      `${header}` +
      "       The file is not a plain SQLite database and LAWHA_DB_KEY is not\n" +
      "       set. Two things look identical from here:\n" +
      "\n" +
      "         - the file is ENCRYPTED and intact, and LAWHA_DB_KEY needs to\n" +
      "           be set to the key it was encrypted with; or\n" +
      "         - the file was never encrypted and its header is DAMAGED, in\n" +
      "           which case the answer is the most recent backup.\n" +
      "\n" +
      "       If LAWHA_DB_KEY has never been set on this deployment, the\n" +
      "       second is the likelier one. Nothing here has changed the file\n" +
      "       either way.\n" +
      REFUSING
    );
  }

  return (
    `${header}` +
    "       LAWHA_DB_KEY does not decrypt this database. The data is still\n" +
    "       there and untouched — to SQLite a wrong key and a damaged file\n" +
    '       look identical, and it reports both as "file is not a database".\n' +
    "       Check LAWHA_DB_KEY against the key this database was encrypted\n" +
    "       with.\n" +
    REFUSING
  );
};

/**
 * Never throws: this runs while an error is already being built, and an
 * unreadable file simply is not a plaintext SQLite one.
 */
const readsAsPlaintextSqlite = (dbPath: string): boolean => {
  let handle: number | undefined;
  try {
    handle = fs.openSync(dbPath, "r");
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const read = fs.readSync(handle, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
};

export const openDatabase = ({
  path: dbPath,
  migrate = true,
  key = null,
}: OpenDatabaseOptions): LawhaDatabase => {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  if (key !== null) {
    // DO NOT REORDER THESE TWO LINES. `cipher` selects the scheme; `key` is
    // interpreted by whichever scheme is selected at the moment it is set, and
    // this driver's default is **chacha20**, not sqlcipher. Key-first writes a
    // chacha20 database and the later `cipher=sqlcipher` does not convert it —
    // so a reorder silently changes the ON-DISK FORMAT, every existing
    // encrypted database stops opening, and the operator is told
    // "LAWHA_DB_KEY does not decrypt this database".
    //
    // NOTHING CHECKS THIS ORDER. Measured on 2026-08-26 by swapping the two
    // lines and running both gates: `node --test scripts/*.test.mjs` reported
    // 125/125 pass, and the seven vitest files under `lawha-server/src/`
    // reported 82/82. Neither reaches this branch — it is entered only when a
    // key is configured, and no surviving test configures one.
    //
    // Two earlier versions of this comment each credited a test that could not
    // catch it. The first named `dbEncryption.test.ts`, which DID pin it and
    // was deleted by `59930dbf` with every other Lawha suite — it still prints
    // with `git show 59930dbf^:lawha-server/tests/integration/dbEncryption.test.ts`.
    // The second, written on 2026-08-25 while correcting the first, named
    // `scripts/encrypt-db.test.mjs`; that file pins how the key is ESCAPED
    // (`keyPragma`, its "escapes the key exactly the way src/db/index.ts does"
    // case) and the order of `cipher` against the read-back probe INSIDE
    // `encrypt-db.mjs` — never the two lines below.
    //
    // So this comment is the only guard, which is why it is this long. A
    // DO-NOT-REORDER pointing at a test nobody can find is an invitation to
    // reorder it; one pointing at a test that exists but does not cover the
    // line is worse, because it survives being checked.
    db.pragma("cipher=sqlcipher");
    db.pragma(keyPragma(key));
  }

  // Before journal_mode, before the migrations, before anything else reads a
  // page. See the comment on this function: it is what turns "file is not a
  // database" into a sentence that names the setting.
  assertDatabaseOpens(db, dbPath, key);

  // WAL lets readers proceed during a write, which matters because the scene
  // CAS write holds a transaction while collaborators are polling.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  if (migrate) {
    runMigrations(db);
  }

  return db;
};

export { runMigrations } from "./migrate.js";
