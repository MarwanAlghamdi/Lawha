/**
 * Turn a plaintext `lawha.db` into a SQLCipher one, keyed with LAWHA_DB_KEY.
 *
 *   LAWHA_DB_KEY=… yarn --cwd lawha-server encrypt-db [--db <path>]
 *
 * **This is the one operation in the project that can lose every board at
 * once**, and the whole file is shaped around that. Nothing here deletes a
 * database. The plaintext original is renamed to `<db>.pre-encryption` and
 * left on disk; removing it is the operator's decision, taken by hand, after
 * they have started the server against the encrypted file and seen their
 * boards. `restore.mjs` uses the same discipline for the same reason, and
 * this is the second half of that lesson: the procedure that once destroyed
 * this deployment's accounts began by deleting the live data before anything
 * had been proven about what was replacing it.
 *
 * The order is the point:
 *
 * 1. REFUSE before touching anything — no key, a key the server itself would
 *    not boot with, a missing or empty file, a `<db>.pre-encryption` already
 *    sitting there, a file that is not plaintext SQLite, or a page size
 *    SQLCipher cannot rekey (see PAGE SIZE below). Every one of these costs
 *    nothing at this point and is unrecoverable later.
 * 2. Prove nobody else has the database open, by taking an exclusive lock on
 *    it (`claimExclusively`, lifted from `restore.mjs` — its comment there
 *    carries the full story of why a checkpoint is NOT that proof), then
 *    checkpoint it so `lawha.db` holds every page before it is copied or
 *    moved. Without the checkpoint both the copy and the kept original would
 *    risk being a 4KB header with the data stranded in a `-wal`.
 * 3. Count every table, and record the schema, from the source.
 * 4. COPY, through SQLite's own online backup API, to `<db>.encrypting-…`
 *    beside the database. Never onto `lawha.db`.
 * 5. ENCRYPT that copy in place — `journal_mode = DELETE`, `cipher =
 *    sqlcipher`, `PRAGMA rekey`.
 * 6. VERIFY the copy on a fresh connection, opened exactly the way
 *    `src/db/index.ts` opens the live database, and compare the schema and
 *    the per-table counts against step 3. **A mismatch refuses outright**,
 *    with the original still in its place and untouched.
 * 7. Move the original aside as `<db>.pre-encryption`, then install the
 *    verified copy with one atomic rename, then verify again from `lawha.db`
 *    itself — "the copy is good" and "the copy is what landed" are different
 *    claims.
 *
 * SQLCIPHER_EXPORT, AND WHY THIS DOES NOT USE IT. The spec and this task's
 * brief both call for `ATTACH` + `sqlcipher_export()`. That function does not
 * exist in this driver: `better-sqlite3-multiple-ciphers` 12.11.1 bundles
 * SQLite3 Multiple Ciphers 2.3.5, whose `pragma_function_list` contains
 * `sqlite3mc_codec_data`, `sqlite3mc_config` and `sqlite3mc_version` and no
 * export function at all — calling it answers `no such function:
 * sqlcipher_export`. `ATTACH DATABASE '…' KEY '…'` does work and does produce
 * a genuinely sqlcipher-encrypted file, but with no `sqlcipher_export` the
 * schema and every row would have to be copied across by hand, which means
 * rewriting each `CREATE …` statement in `sqlite_master` to name the attached
 * schema. Hand-rolled DDL surgery is exactly the wrong thing to put in the
 * one command that can lose every board; `sqlcipher_export` exists precisely
 * because that is hard.
 *
 * What replaces it copies MORE faithfully, not less: `db.backup()` is
 * SQLite's online backup API, page for page, and it is already what
 * `backup.mjs` runs against this database every six hours. Indexes, views,
 * triggers, `user_version` and `sqlite_sequence` come across because nothing
 * is being re-created — the bytes are copied and then encrypted in place.
 * The brief's "not `db.backup()`" is about the pairing Task 6 measured
 * throwing, a PLAIN source backed up to an ENCRYPTED target; this backup is
 * plain to plain, and the encryption happens afterwards, to the copy.
 *
 * PAGE SIZE. `PRAGMA rekey` reports `ok` on a 512-byte-page database, rewrites
 * the header so the file looks encrypted, and produces something the CORRECT
 * key cannot open — a silent, total loss if it were ever installed. Measured
 * across every power of two from 512 to 65536: 512 is the only one that
 * fails. (SQLite requires at least 480 usable bytes per page and SQLCipher
 * reserves some of every page for its IV and HMAC, which is the obvious
 * explanation and is inference rather than something read out of the C.) So
 * this refuses a page size under 1024 up front, by name — and step 6 verifies
 * regardless, because refusing by name only covers the cause already known.
 *
 * INTERRUPTS. The dangerous window is between the original being moved aside
 * and the copy being installed. It is not empty — the sidecars are dealt with
 * in there, so it holds `existsSync`, `statSync`, `unlinkSync`, a `renameSync`
 * and possibly a `warn` between the two renames that bound it. What it does
 * not hold is a YIELD POINT, and that is the property that matters: a JS
 * handler only runs once the current synchronous stretch finishes or yields,
 * so a signal arriving in this window is queued until after the window has
 * closed. `encrypt-db.test.mjs` pins exactly that — it asserts there is no
 * `await` between those two lines — rather than trusting this paragraph, and
 * review could not enter the window even by raising SIGTERM from inside the
 * `rename()` syscall itself. What CAN be interrupted is step 4,
 * which yields every 100 pages, and that is entirely before the live database
 * has been touched. SIGKILL is not catchable anywhere, and survivable only
 * because `lawha.db` is never WRITTEN to: it is renamed away, once, at the
 * end.
 */
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import CipherDatabase from "better-sqlite3-multiple-ciphers";

/** Same duplication, same reason, as `backup.mjs` and `restore.mjs`. */
const DEFAULT_DB_PATH = "./lawha-data/lawha.db";

/**
 * The wrong-file guard, not the comparison. What gets compared is every table
 * the database actually has; these four only answer "is this a Lawha
 * database at all", the same way `restore.mjs` uses them.
 */
const COUNTED_TABLES = ["users", "boards", "board_scenes", "files"];

/**
 * Must equal `MIN_DB_KEY_LENGTH` in `src/config.ts`, and a test compares the
 * two directly rather than leaving them as independent literals. Drift here
 * is not cosmetic: a key this accepts and the server refuses produces an
 * encrypted database that the only process able to read it will not boot to
 * open, and there is no second tool that undoes the encryption.
 */
const MIN_DB_KEY_LENGTH = 16;

/** See PAGE SIZE in the header comment. */
const MIN_ENCRYPTABLE_PAGE_SIZE = 1024;

/** Same value and same reasoning as `restore.mjs`'s. */
const CLAIM_TIMEOUT_MS = 1000;

/**
 * The first sixteen bytes of every unencrypted SQLite file, exactly as
 * `SQLITE_MAGIC` in `src/db/index.ts`. The NUL is `\0` rather than a literal
 * for the reason recorded there: a raw NUL makes git treat the file as binary
 * and the diff stops being reviewable.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

const USAGE =
  "usage: LAWHA_DB_KEY=… yarn --cwd lawha-server encrypt-db [--db <path>]\n";

const fail = (message) => {
  process.stderr.write(`lawha: ${message}\n`);
  process.exit(1);
};

const say = (message) => process.stdout.write(`${message}\n`);

const warn = (message) => process.stderr.write(`${message}\n`);

/**
 * See the same handler in `backup.mjs` and `restore.mjs`. Piping this into
 * `head` closes stdout mid-run; a broken pipe is not a failure of the work,
 * and every other write error still is.
 */
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

/**
 * The same for stderr, which `backup.mjs` and `restore.mjs` both leave out —
 * and it matters MORE here than it does in either of them.
 *
 * `2>&1 | head` after a fully successful migration exited 1, because this
 * command writes its closing WARNING to stderr and `head` had already gone.
 * A non-zero exit from THIS command is precisely the thing that sends an
 * operator round again — and a second run is the one that finds
 * `lawha.db.pre-encryption` in the way and has to be reasoned about. The
 * cheapest way not to send them there is to not lie about the exit code.
 */
process.stderr.on("error", (error) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

const stamp = (date) => {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

/**
 * `key='…'` with the passphrase escaped as a SQL string literal — the same
 * function, character for character, as `keyPragma` in `src/db/index.ts`, and
 * the doubling is the whole of the safety. A key containing a `'` would
 * otherwise terminate the literal early, SQLCipher would derive from a
 * truncated passphrase, and the operator would end up with a database whose
 * real key is a prefix of the one they wrote down. If the two ever disagree,
 * this command encrypts with one key and the server opens with another.
 */
const keyLiteral = (key) => `'${key.replace(/'/g, "''")}'`;

const readsAsPlaintextSqlite = (file) => {
  let handle;
  try {
    handle = fs.openSync(file, "r");
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

/**
 * Open `file` with the key, the way `src/db/index.ts` does it, and prove it
 * by reading. Returns the connection, or null if it will not open.
 *
 * The read is not ceremony. SQLCipher does NOT validate a key when it is set
 * — `PRAGMA key` answers `ok` for any value, right or wrong, because no page
 * has been read yet — so a function that stopped after the pragmas would
 * report every key as correct. `cipher` comes before `key` for the reason
 * `src/db/index.ts` gives: the key is interpreted by whichever scheme is
 * selected at the moment it is set.
 *
 * `fileMustExist` so that a mistyped path can never leave a new, empty,
 * encrypted database behind as a side effect of asking a question about one.
 */
const openEncrypted = (file, key) => {
  let db;
  try {
    db = new CipherDatabase(file, { fileMustExist: true });
  } catch {
    return null;
  }

  try {
    db.pragma("cipher=sqlcipher");
    db.pragma(`key=${keyLiteral(key)}`);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch {
    db.close();
    return null;
  }
};

const tableExists = (db, name) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;

/**
 * Every table the database actually holds, in a stable order. `sqlite_%` is
 * excluded because those are SQLite's own (`sqlite_sequence`,
 * `sqlite_autoindex_…`); they are covered by the schema comparison instead,
 * which sees them by name.
 */
const tableNamesOf = (db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

const countTables = (db, tables) =>
  tables.map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
  ]);

/**
 * Every object in `sqlite_master`, with its DDL, as one comparable string.
 *
 * Counts alone would not notice an index or a trigger that failed to come
 * across, and a page-for-page copy has no honest reason to change any of
 * this — so any difference means something happened that nobody designed.
 */
const schemaOf = (db) =>
  db
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .map((row) => `${row.type} ${row.name} ${row.sql ?? ""}`)
    .join("\n");

const report = (counts) => {
  for (const [table, n] of counts) {
    say(`lawha:   ${String(n).padStart(6)}  ${table}`);
  }
};

/**
 * Take the database exclusively, and hand back the connection if it worked.
 *
 * Lifted from `restore.mjs`, whose comment on the same function records why
 * this is the check and `wal_checkpoint(TRUNCATE)` is not: TRUNCATE reports
 * `busy` only when a transaction is in flight, so an idle-but-open server
 * sails straight past it. In WAL mode every attached connection holds a piece
 * of the wal-index, so the first transaction taken in exclusive locking mode
 * fails with SQLITE_BUSY while anybody else is attached. Its two documented
 * limits apply here unchanged, including the one that matters most: a server
 * that starts between this claim and the rename below is a race no in-process
 * check can close. Stop the stack; this is a backstop for forgetting to.
 */
const claimExclusively = (file) => {
  let db;

  try {
    db = new Database(file, { timeout: CLAIM_TIMEOUT_MS });
  } catch (error) {
    return { db: null, reason: `cannot open it: ${error.message}` };
  }

  try {
    db.pragma("locking_mode = EXCLUSIVE");
    // The pragma alone proves nothing — exclusive locking mode is lazy and the
    // locks are taken by the next transaction. Neither statement writes a
    // page: BEGIN IMMEDIATE takes the lock and the ROLLBACK gives it back.
    db.exec("BEGIN; SELECT COUNT(*) FROM sqlite_master; COMMIT;");
    db.exec("BEGIN IMMEDIATE; ROLLBACK;");
  } catch (error) {
    db.close();
    return { db: null, reason: error.message };
  }

  return { db, reason: null };
};

const args = process.argv.slice(2).flatMap((arg) => {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
});

let dbPath = process.env.LAWHA_DB_PATH || DEFAULT_DB_PATH;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--db") {
    i += 1;
    dbPath = args[i];
    if (!dbPath) {
      fail("--db needs a path");
    }
  } else {
    process.stderr.write(USAGE);
    fail(`unexpected argument "${arg}"`);
  }
}

dbPath = path.resolve(dbPath);

/**
 * Read straight from the environment rather than through `loadConfig`, for
 * the reason `restore.mjs` gives for not importing `ageEncrypt.ts`: this
 * script runs under plain `node`, and `src/` is TypeScript this process
 * cannot load without a build step that `test:scripts` must not depend on.
 * The floor `loadConfig` enforces is therefore re-stated below and pinned to
 * it by a test.
 *
 * Not trimmed and not normalised, exactly as `src/config.ts` carries it: a
 * key altered on the way past would open nothing, and the operator's only
 * evidence would be a value in `lawha.env` that looks right.
 */
const key = process.env.LAWHA_DB_KEY || "";

if (!key) {
  fail(
    "LAWHA_DB_KEY is not set. That is the key this will encrypt the database " +
      "WITH, and the key the server will need to open it ever again — there " +
      "is no way back without it. Put it in lawha.env first, then run this " +
      "with the same value.",
  );
}

if (key.length < MIN_DB_KEY_LENGTH) {
  fail(
    `LAWHA_DB_KEY is ${key.length} characters and the server refuses to boot ` +
      `with anything under ${MIN_DB_KEY_LENGTH} (src/config.ts). Encrypting ` +
      "with it would produce a database only a server that will not start " +
      "can open. Nothing has been changed.",
  );
}

const aside = `${dbPath}.pre-encryption`;

/**
 * Every partial copy an earlier run left beside the database, by name.
 *
 * Read in two places — here, where a missing `lawha.db` needs them named as
 * evidence, and again before the copy starts, where they are a warning. One
 * function so the two cannot describe the same files differently.
 */
const encryptingLeftovers = () =>
  fs
    .readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith(`${path.basename(dbPath)}.encrypting-`))
    .sort();

if (!fs.existsSync(dbPath)) {
  /**
   * The one state where the operator most needs to be told something, and
   * where saying only "no such database" is close to cruelty: a SIGKILL
   * landed between the two renames, so `lawha.db` is genuinely gone and its
   * contents are sitting one filename away, complete and plaintext.
   *
   * Reproduced deterministically in review, which is why this branch exists.
   * The recovery is one `mv` and it is spelled out rather than described,
   * because whoever is reading this has just lost a file they cannot afford
   * to lose and should not have to compose a command.
   *
   * The staging copy is NAMED but not offered as the thing to install: it is
   * verified only if the run got as far as verifying it, and this branch
   * cannot know whether it did. The plaintext original is the copy whose
   * contents are certain.
   */
  if (fs.existsSync(aside)) {
    const partial = encryptingLeftovers();

    fail(
      `there is no database at ${dbPath}, but ${aside} IS there.\n` +
        "lawha: That is your data. This command was interrupted between " +
        "moving the\n" +
        "lawha: original aside and installing the encrypted copy — nothing " +
        "was lost.\n" +
        (partial.length > 0
          ? `lawha: (${partial.join(", ")} ${
              partial.length === 1 ? "is" : "are"
            } the interrupted copy; leave ${
              partial.length === 1 ? "it" : "them"
            } alone for now.)\n`
          : "") +
        "lawha:\n" +
        `lawha: Put it back, and then run this again:\n` +
        `lawha:     mv ${aside} ${dbPath}`,
    );
  }

  fail(`no such database: ${dbPath}`);
}

if (fs.statSync(dbPath).size === 0) {
  // A zero-byte file has no magic in it, so the header check below would read
  // it as "not plaintext"; and SQLite accepts ANY key against an empty file,
  // because there is no page to fail on. The two together would report an
  // empty file as already encrypted, which is a confusing way to be told
  // there is nothing here.
  fail(
    `${dbPath} is an empty file — there is nothing to encrypt. Start the ` +
      "server with LAWHA_DB_KEY set and it will create an encrypted database " +
      "itself.",
  );
}

/**
 * What the FILE is, asked before what is beside it. On an ordinary second run
 * both this and the `aside` guard below are true, and this is the one worth
 * printing: "already encrypted" tells the operator the migration they are
 * repeating already succeeded, where "there is a file in the way" leaves them
 * wondering what state they are in.
 */
if (!readsAsPlaintextSqlite(dbPath)) {
  const already = openEncrypted(dbPath, key);

  if (already) {
    already.close();
    fail(
      `${dbPath} is already encrypted with LAWHA_DB_KEY. Nothing to do, and ` +
        "nothing has been changed.",
    );
  }

  // Everything else that is not plaintext collapses into this one branch, and
  // the message says so instead of guessing: encrypted with a different key,
  // truncated, corrupted or simply not a database all look identical from
  // out here — `src/db/index.ts`'s `describeFailure` records the same limit
  // for the same reason.
  fail(
    `${dbPath} is not a plain SQLite database, and LAWHA_DB_KEY does not ` +
      "open it either. It may be encrypted with a different key, or damaged " +
      "— from outside those look identical. Nothing has been changed; check " +
      "LAWHA_DB_KEY before doing anything else.",
  );
}

if (fs.existsSync(aside)) {
  // Independent of the check above, and deliberately so. That one catches the
  // ordinary second run; this one catches the run where a plaintext database
  // has since been restored over the top — where writing over the aside would
  // destroy the only plaintext copy of the earlier data.
  fail(
    `${aside} is already there. That is the plaintext original kept by an ` +
      "earlier run of this command, and this refuses rather than write over " +
      "it. Move it somewhere safe — or remove it deliberately — and run this " +
      "again. Nothing has been changed.",
  );
}

/**
 * Leftovers from a run that was killed outright, named so an operator finding
 * a second multi-megabyte file beside their database is not left guessing.
 *
 * A warning and never a refusal, and never a deletion. SIGKILL cannot be
 * caught, so the exit handler below does not run and these survive; they are
 * a partial copy — plaintext if the process died during the copy, ciphertext
 * if it died during the encryption — and neither is anybody's database.
 * Removing them here would be this command deleting a file it did not create
 * in this run, which is exactly the habit the whole design refuses.
 */
const leftovers = encryptingLeftovers();

if (leftovers.length > 0) {
  warn(
    `lawha: WARNING — ${leftovers.join(", ")} ${
      leftovers.length === 1 ? "is a partial copy" : "are partial copies"
    } left behind by an\nlawha: earlier run of this command that was killed. ` +
      "Neither your database nor a\nlawha: backup; safe to remove by hand, " +
      "and nothing here will touch them.",
  );
}

const now = stamp(new Date());
const stagingPath = `${dbPath}.encrypting-${now}`;
const wal = `${dbPath}-wal`;
const shm = `${dbPath}-shm`;

/**
 * Where this run stands, for the interrupt handler to describe honestly.
 * `"before-move"` covers everything up to and including verifying the
 * encrypted copy — the live database has not been touched, so an interrupt
 * there changes nothing. `"moved-aside"` starts the instant the original is
 * renamed and lasts until the copy is installed; see INTERRUPTS in the header
 * for why no signal can actually land inside it. `"installed"` is set only
 * once the atomic rename onto `dbPath` has completed.
 */
let phase = "before-move";

/**
 * The one recovery sentence, said the same way by every path that can reach
 * the state it describes — the interrupt handler, the install's own `catch`,
 * and the two verification failures after the install.
 *
 * Factored out rather than written four times because `restore.mjs` was
 * reviewed and found with exactly the opposite arrangement: the sentence
 * existed only on the signal path, which cannot fire in a synchronous
 * stretch, while the failure that IS reachable there — a full disk, a
 * permissions error — produced a raw exception with `lawha.db` simply gone
 * and nothing printed about where its contents went.
 */
const asideRecoveryAdvice = () =>
  `your data is safe at ${aside}; move it back over ${dbPath} yourself, ` +
  "before starting the server.";

/**
 * The staging copy AND its own sidecars, removed unconditionally on the way
 * out — success, `fail()`, or a signal, all funnel through `process.exit()`.
 * Once the copy has been renamed onto `dbPath` there is nothing at these
 * names to remove and this is a no-op; none of them can ever be the database
 * or the original, because all four are derived from `stagingPath`.
 *
 * The sidecars are listed because leaving them out was measured, not
 * imagined: a SIGTERM during the copy removed `…encrypting-<stamp>` and left
 * `…encrypting-<stamp>-journal` sitting in the operator's data directory,
 * a dangling sidecar beside a name that no longer exists.
 *
 * Each removal gets its own `try` for the reason `restore.mjs` records on its
 * exit handler: `{ force: true }` suppresses ENOENT but not ENOTDIR, and a
 * crash here would print a second, unrelated stack trace on top of the real
 * failure this process is already exiting to report.
 */
process.on("exit", () => {
  for (const scratch of [
    stagingPath,
    `${stagingPath}-journal`,
    `${stagingPath}-wal`,
    `${stagingPath}-shm`,
  ]) {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // Best effort. A stray staging file is a loose end to clean up by hand,
      // never a reason to mask the failure being reported.
    }
  }
});

/**
 * With no handler these three signals' default disposition is "terminate",
 * delivered by the kernel between any two machine instructions. Registering a
 * handler replaces that with a queued JS callback, which is what makes the
 * move-aside → install stretch below impossible to split. See INTERRUPTS in
 * the header comment.
 */
const INTERRUPTS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

for (const [signal, number] of Object.entries(INTERRUPTS)) {
  process.on(signal, () => {
    if (phase === "moved-aside") {
      warn(
        `lawha: interrupted by ${signal} — the plaintext database was moved ` +
          `aside to ${aside} and NOTHING has been installed at ${dbPath} ` +
          `yet.\nlawha: ${asideRecoveryAdvice()}`,
      );
    } else if (phase === "installed") {
      warn(
        `lawha: interrupted by ${signal} after the encrypted database was ` +
          `installed at ${dbPath} — verification may not have finished. The ` +
          `plaintext original is at ${aside}; compare the counts by hand ` +
          "before removing it.",
      );
    } else {
      warn(
        `lawha: interrupted by ${signal} before anything was moved; nothing ` +
          "was changed.",
      );
    }
    // 128+n is what a shell reports for a signalled process, matching both
    // other scripts' handlers.
    process.exit(128 + number);
  });
}

const claim = claimExclusively(dbPath);

if (!claim.db) {
  fail(
    `the database at ${dbPath} is in use — stop the server first ` +
      "(`docker compose stop lawha-server`), then run this again. Encrypting " +
      "under a live process leaves it writing to a database that is no longer " +
      `there. (${claim.reason}) Nothing has been changed.`,
  );
}

const live = claim.db;

const integrity = live.pragma("integrity_check")[0]?.integrity_check;

if (integrity !== "ok") {
  live.close();
  fail(
    `integrity_check on ${dbPath} said "${integrity}", not "ok". Encrypting a ` +
      "damaged database would only make it a damaged database nobody can " +
      "read. Nothing has been changed.",
  );
}

const missing = COUNTED_TABLES.filter((table) => !tableExists(live, table));

if (missing.length > 0) {
  live.close();
  fail(
    `${dbPath} has no ${missing.join(", ")} table — is that really the Lawha ` +
      "database? Nothing has been changed.",
  );
}

const pageSize = live.pragma("page_size")[0]?.page_size;

if (pageSize < MIN_ENCRYPTABLE_PAGE_SIZE) {
  live.close();
  fail(
    `${dbPath} has a page size of ${pageSize}, and SQLCipher cannot encrypt ` +
      `a database in place below ${MIN_ENCRYPTABLE_PAGE_SIZE}: the rekey ` +
      "reports success and produces a file the correct key cannot open. " +
      "Nothing has been changed. Take a backup, `VACUUM` it into a larger " +
      "page size, and encrypt that instead.",
  );
}

// Before the copy AND before the move, so that both the staging copy and the
// original kept beside it hold every page. Skipping it is the WAL hazard that
// has already cost this deployment its accounts once: a `lawha.db` that is a
// 4KB header with the tables stranded in a `-wal` next to it.
live.pragma("wal_checkpoint(TRUNCATE)");

const sourceTables = tableNamesOf(live);
const sourceCounts = countTables(live, sourceTables);
const sourceSchema = schemaOf(live);

say(`lawha: encrypting ${dbPath}`);
report(sourceCounts);

try {
  // The online backup API, page for page — the same mechanism `backup.mjs`
  // uses against this database, and the reason a `cp` is never acceptable
  // here. It yields to the event loop every 100 pages, which makes this the
  // one genuinely interruptible stretch in the run; it is also entirely
  // before anything about the live database has moved.
  await live.backup(stagingPath);
} catch (error) {
  live.close();
  fail(
    `could not copy ${dbPath} to ${stagingPath}: ${error.message}. Nothing ` +
      "has been changed.",
  );
}

live.close();

try {
  const staging = new CipherDatabase(stagingPath, { fileMustExist: true });
  // DELETE first: `PRAGMA rekey` is refused outright in WAL mode ("Rekeying
  // is not supported in WAL journal mode"), and a rollback-journal database
  // also means the file installed below arrives with no sidecars of its own.
  // The server sets WAL again on its next open.
  staging.pragma("journal_mode = DELETE");
  // `cipher` before the key, for the reason `src/db/index.ts` gives.
  staging.pragma("cipher=sqlcipher");
  staging.pragma(`rekey=${keyLiteral(key)}`);
  staging.close();
} catch (error) {
  fail(
    `could not encrypt the copy at ${stagingPath}: ${error.message}. ` +
      `${dbPath} has not been changed.`,
  );
}

const staged = openEncrypted(stagingPath, key);

if (!staged) {
  // The rekey above can report `ok` and still produce this — see PAGE SIZE in
  // the header. It is exactly what this verification exists for, and it is
  // why the encrypted copy is proven readable before the original moves an
  // inch.
  fail(
    `the encrypted copy at ${stagingPath} does not open with LAWHA_DB_KEY, ` +
      "even though encrypting it reported success. Nothing has been changed " +
      `and ${dbPath} is exactly as it was.`,
  );
}

const stagedCounts = countTables(staged, sourceTables);
const stagedSchema = schemaOf(staged);
const stagedIntegrity = staged.pragma("integrity_check")[0]?.integrity_check;
staged.close();

/**
 * Per table, and any difference is a refusal rather than a warning.
 *
 * A page-for-page copy followed by an in-place rekey cannot change a row
 * count, so a difference here does not mean "slightly wrong" — it means
 * something happened that nothing in this file designed, and the only safe
 * response is to leave the original where it is.
 */
const drift = sourceCounts
  .map(([table, n], i) => [table, n, stagedCounts[i]?.[1]])
  .filter(([, n, copied]) => copied !== n);

if (stagedIntegrity !== "ok") {
  fail(
    `integrity_check on the encrypted copy said "${stagedIntegrity}", not ` +
      `"ok". Nothing has been changed and ${dbPath} is exactly as it was.`,
  );
}

if (stagedSchema !== sourceSchema) {
  fail(
    "the encrypted copy does not have the same schema as the database it was " +
      `copied from. Nothing has been changed and ${dbPath} is exactly as it ` +
      "was.",
  );
}

if (drift.length > 0) {
  fail(
    "the encrypted copy does not match the database it was copied from — " +
      `${drift
        .map(([table, n, copied]) => `${table}: before ${n}, after ${copied}`)
        .join(
          "; ",
        )}. Nothing has been changed and ${dbPath} is exactly as it ` +
      "was; investigate before running this again.",
  );
}

fs.renameSync(dbPath, aside);
phase = "moved-aside";

/**
 * The sidecars and the install, in one `try`, and both between the two
 * renames — no yield point, see INTERRUPTS.
 *
 * The `try` is there because a signal is NOT what can reach this window; a
 * plain synchronous I/O failure is. `restore.mjs` shipped without one and was
 * caught in review: an unwritable directory or a full disk here left
 * `lawha.db` renamed away with a raw V8 stack trace in its place, while the
 * recovery sentence written for exactly this state hung off a signal branch
 * that could never fire. Same failure, same window, same fix.
 *
 * On the sidecars themselves: the checkpoint above folded every page into the
 * file that has just been moved, and closing the connection normally removes
 * both of these, so the usual case is that neither exists. Nothing that could
 * still hold pages is deleted — a `-wal` the checkpoint did not empty is
 * renamed alongside its own database so the pair stays openable, because
 * deleting it would be the data loss this command exists to avoid. `-shm` is
 * pure scratch and SQLite rebuilds it.
 */
try {
  if (fs.existsSync(wal)) {
    if (fs.statSync(wal).size === 0) {
      fs.unlinkSync(wal);
    } else {
      fs.renameSync(wal, `${aside}-wal`);
      warn(
        `lawha: WARNING — ${wal} still held pages and was kept as ${aside}-wal`,
      );
    }
  }

  if (fs.existsSync(shm)) {
    fs.unlinkSync(shm);
  }

  fs.renameSync(stagingPath, dbPath);
  phase = "installed";
} catch (error) {
  fail(
    `could not install the encrypted database: ${error.message}\n` +
      `lawha: ${asideRecoveryAdvice()}`,
  );
}

/**
 * "The copy is good" and "the copy is what landed" are different claims, and
 * printing two count blocks without subtracting them is how a restore in this
 * project once reported one number for the artefact and another for the
 * result and still exited zero.
 */
const installed = openEncrypted(dbPath, key);

if (!installed) {
  fail(
    `${dbPath} was installed but does not open with LAWHA_DB_KEY — ` +
      `${asideRecoveryAdvice()} Do NOT start the server until you know why.`,
  );
}

/**
 * Wrapped for the same reason the install above is, and it is the same shape
 * of gap review found in `restore.mjs`: this runs AFTER the original has been
 * moved aside, so anything that throws here reaches the operator as a raw
 * stack trace at the exact moment their data is not where they left it.
 *
 * `openEncrypted` has already proved the file opens and `sqlite_master` reads,
 * so a throw here needs something like a disk error mid-read — practically
 * unreachable, and one line of `try` is a cheap price for never finding out
 * the hard way that "practically" was doing work in that sentence.
 */
let installedCounts;

try {
  installedCounts = countTables(installed, sourceTables);
  installed.close();
} catch (error) {
  fail(
    `${dbPath} was installed but could not be read back: ${error.message}\n` +
      `lawha: ${asideRecoveryAdvice()} Do NOT start the server until you ` +
      "know why.",
  );
}

const landedDrift = sourceCounts
  .map(([table, n], i) => [table, n, installedCounts[i]?.[1]])
  .filter(([, n, landed]) => landed !== n);

if (landedDrift.length > 0) {
  fail(
    `what landed at ${dbPath} does not match what was verified — ` +
      `${landedDrift
        .map(([table, n, landed]) => `${table}: before ${n}, after ${landed}`)
        .join("; ")}. ${asideRecoveryAdvice()} Investigate before starting ` +
      "the server.",
  );
}

say(`lawha: encrypted ${dbPath}`);
report(installedCounts);
say("lawha:");
say(`lawha: the plaintext original is kept at ${aside}`);
say("lawha: This command will never delete it — that is yours to do, by hand,");
say("lawha: once you have started the server with LAWHA_DB_KEY set and seen");
say("lawha: that your boards are all there.");
say("lawha:");
say("lawha: The database is now unreadable without LAWHA_DB_KEY. Losing that");
say("lawha: value loses every board with it; there is no recovery path.");

/**
 * Said on the way out because it is the next thing that goes wrong.
 *
 * Task 6 measured every backup path in this project failing against a keyed
 * database, and this command used to close by warning that they would. Task 7B
 * taught all three the key, so the warning would now be false — but the thing
 * it was really about has not gone away: `LAWHA_DB_KEY` lives in `lawha.env`,
 * which only ever reaches the CONTAINERS. The scheduled backup in
 * `lawha-backup` therefore has it and keeps working; a backup or restore run
 * BY HAND on the host does not, and refuses by name rather than doing anything
 * silent. Saying so here costs one line and saves the operator finding out on
 * the day they need a restore.
 */
warn("");
warn(
  "lawha: NOTE — the scheduled backup and the /admin download both read",
);
warn(
  "lawha: LAWHA_DB_KEY from lawha.env and keep working, and every artefact",
);
warn(
  "lawha: they write from now on is encrypted with it. A backup or restore run",
);
warn(
  "lawha: BY HAND on the host does NOT see lawha.env — export LAWHA_DB_KEY for",
);
warn(`lawha: those. Check that you can still take one before you remove ${aside}.`);
