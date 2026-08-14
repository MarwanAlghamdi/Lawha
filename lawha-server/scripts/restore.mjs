/**
 * Put a verified backup back, without ever deleting what is already there.
 *
 *   yarn --cwd lawha-server restore <backup-file> [--db <path>] [--force]
 *                                    [--identity <path>] [--files <dir>]
 *
 * This is the half that has historically gone wrong. The procedure that used
 * to live in README.md began `docker volume rm excalidraw_lawha-data`, and
 * that instruction is what destroyed this deployment's accounts: it deletes
 * the live data BEFORE anything has been proven about the archive replacing
 * it, so a bad archive leaves you with nothing at all. Nothing here deletes a
 * database. The existing one is moved aside as `<db>.pre-restore-<stamp>` and
 * left on disk for you to remove by hand once you are satisfied.
 *
 * The order is the point:
 *
 * 1. DECRYPT the backup, if it is one — `lawha-<stamp>.db.age`, or anything
 *    else that opens with `age`'s own format signature. The private key
 *    reaches this script as `--identity <path>` or piped on stdin, and NEVER
 *    any other way: not `lawha.env`, not a container path, not an
 *    environment variable read for you. Putting the key anywhere the server
 *    can reach it undoes the entire reason Half A exists — the server can
 *    write backups it cannot read, and this script is the one place that
 *    changes, run by a human, on the host, holding a key nothing else has.
 * 2. Verify the BACKUP (the decrypted plaintext, or the file itself if it was
 *    never encrypted) — `integrity_check` plus the four tables plus their row
 *    counts, printed, so you can see what you are about to install before
 *    anything moves. A refusal here costs nothing.
 * 3. Prove nobody else has the LIVE database open, by taking an exclusive lock
 *    on it (see `claimExclusively`), and then checkpoint it
 *    (`wal_checkpoint(TRUNCATE)`) so that `lawha.db` contains every page before
 *    it is moved. Without the checkpoint the move-aside would strand the tables
 *    in a `-wal` that no longer has a database next to it — the same WAL hazard
 *    as `cp`, wearing a different hat. A failed claim means the server is still
 *    running and is a hard stop, because installing a file under a live process
 *    leaves it holding a descriptor to a database that is no longer there.
 * 4. Move the live triple aside. Only a `-wal` the checkpoint emptied is
 *    removed — one still holding pages is renamed alongside its database so
 *    the set stays openable. `-shm` is pure scratch and SQLite rebuilds it.
 *    Sidecars are dealt with WHETHER OR NOT the database itself was there; see
 *    the comment above that block for the restore this asymmetry poisoned.
 * 5. INSTALL the backup, atomically, and behind its own `try`. The verified
 *    plaintext is copied to a `.installing-<stamp>` name beside `lawha.db`
 *    and renamed onto it only once the copy is complete — never copied
 *    straight onto the final name. `fs.copyFileSync` is not atomic; a
 *    straight copy onto `dbPath` would, if interrupted mid-write, leave a
 *    half-written file wearing the live database's own name, with the good
 *    copy already moved aside and nothing readable in its place. The rename
 *    is atomic on the same filesystem, so the live name is either the old
 *    database (still at `aside`, not yet swapped) or the fully-written new
 *    one — never a fragment of it. The `try` exists because "atomic" only
 *    means the rename cannot land half-done; it says nothing about the copy
 *    or the rename FAILING outright — a full disk, a permissions error — and
 *    that failure, unlike a signal (below), is genuinely reachable here.
 * 6. Verify what actually landed, COMPARE it against what the backup held, and
 *    then say what to check next. Printing two count blocks and never
 *    subtracting them is how a restore reported "1 users" for the artefact and
 *    "5 users" for the result and still exited zero.
 *
 * LAWHA_DB_KEY is a SECOND, INDEPENDENT layer of encryption from the `age` one
 * in step 1, and confusing the two is the easiest mistake to make in this file.
 * `age` protects the ARCHIVE and its private key never comes near this
 * machine's configuration (see step 1). `LAWHA_DB_KEY` is SQLCipher on the
 * database ITSELF, it lives in `lawha.env`, and the server needs it on every
 * boot. A backup taken from a keyed deployment is SQLCipher ciphertext, so:
 *
 * - Verifying it means opening it WITH the key. Everything the verification is
 *   worth — `integrity_check`, the four row counts — comes from reading the
 *   artefact, so a wrong key is caught HERE, before anything moves.
 * - INSTALLING it is an ordinary file copy. Nothing is decrypted on the way
 *   in: the artefact is already in exactly the form the server expects to
 *   open, which is why this file grew no encryption code of its own.
 * - A PLAINTEXT artefact aimed at a keyed deployment is REFUSED rather than
 *   installed. Installing it would produce a database the server declines to
 *   boot against ("LAWHA_DB_KEY is set, but this file is NOT encrypted"),
 *   discovered on the next `docker compose up` instead of here.
 *   `encrypt-db.mjs` already performs that conversion, carefully, keeping the
 *   original; the refusal names it rather than growing a second copy of it in
 *   the one script that must not be clever.
 *
 * Note where the key is on restore day: `lawha.env` reaches the CONTAINERS,
 * and this runs on the HOST. So `LAWHA_DB_KEY` is absent unless the operator
 * exports it, which makes "encrypted artefact, no key" the most reachable
 * mistake here and not an exotic one. It is answered by name.
 *
 * SIGNAL HANDLING exists in this file for the first time, and deliberately —
 * but read this section before crediting it with more than it does. Before
 * this task `restore.mjs` had none at all: with no handler registered,
 * SIGINT/SIGTERM's DEFAULT disposition is "terminate", delivered by the
 * kernel asynchronously, able to strike between any two machine
 * instructions with no dependence on where Node's event loop happens to be.
 * Registering a handler replaces that default with a JS callback — but a JS
 * callback can only RUN once the current synchronous stretch of code
 * finishes or yields. The move-aside → install → verify sequence below is
 * still fully synchronous, with no `await` anywhere inside it, so a signal
 * arriving during that stretch is not "handled" there at all: it is queued,
 * and by the time Node gets around to running the callback, the synchronous
 * stretch — install, verify, drift-check, all of it — has already finished
 * (or already called `fail()`/`process.exit()` from inside it). Reviewed and
 * confirmed live: a SIGTERM injected into this window is swallowed entirely
 * and the restore completes as if it had never been sent. That makes the
 * `restorePhase === "moved-aside"` branch below effectively unreachable
 * under the current code shape — kept anyway, cheaply, as a safety net for
 * if a future change ever adds a real yield point in this stretch (a second
 * `await`, an async write), not because it fires today.
 *
 * What DOES reach this window today is the `try`/`catch` around the install
 * in step 5 — a plain synchronous failure, not a signal — and it prints the
 * exact same recovery sentence (`asideRecoveryAdvice()`) the signal branch
 * would have, shared rather than duplicated so the two cannot drift apart
 * the way they did before this was noticed: the sentence existed only on
 * the path that can never run.
 *
 * The one window that IS genuinely interruptible by a signal is the `await`
 * while `age` decrypts, entirely before anything about the live database
 * has been touched — the `restorePhase === "before-move"` branch below
 * describes exactly that state, and it is real.
 *
 * Ownership needs no thought on the supplied stack: the database is a bind
 * mount at ~/lawha-data, and the host user and the container's `node` are both
 * uid 1000. That was the one thing the old named-volume procedure needed root
 * for.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

/**
 * The cipher driver, loaded LAZILY and only when `LAWHA_DB_KEY` is set — see
 * `loadCipherDriver` below, and `backup.mjs`'s copy of the same comment for
 * the incident. A top-level `import` of it here left the running deployment
 * with no recovery path at the same moment it lost its backups.
 */
let CipherDatabase = null;

/** Same duplication, same reason, as `backup.mjs`. */
const DEFAULT_DB_PATH = "./lawha-data/lawha.db";

const COUNTED_TABLES = ["users", "boards", "board_scenes", "files"];

/**
 * Must equal `MIN_DB_KEY_LENGTH` in `src/config.ts`, same arrangement and same
 * reason as `backup.mjs` and `encrypt-db.mjs`, and pinned to it by a test.
 */
const MIN_DB_KEY_LENGTH = 16;

/**
 * The first sixteen bytes of every unencrypted SQLite file, exactly as
 * `SQLITE_MAGIC` in `src/db/index.ts`. The NUL is `\0` rather than a literal
 * so git does not read this file as binary.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

const USAGE =
  "usage: yarn --cwd lawha-server restore <backup-file> [--db <path>] " +
  "[--force] [--identity <path>] [--files <dir>]\n";

const fail = (message) => {
  process.stderr.write(`lawha: ${message}\n`);
  process.exit(1);
};

const say = (message) => process.stdout.write(`${message}\n`);

/**
 * See the same handler in `backup.mjs`. Piping this into `head` closed stdout
 * mid-run and turned a completed restore into a non-zero exit — the one signal
 * anybody automating this actually reads. A broken pipe is not a failure of
 * the work; every other write error still is.
 */
process.stdout.on("error", (error) => {
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

const tableExists = (db, name) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;

/**
 * `key='…'` with the passphrase escaped as a SQL string literal — the same
 * function, character for character, as `keyPragma` in `src/db/index.ts`. The
 * doubling is the whole of the safety; a key containing a `'` would otherwise
 * terminate the literal early and every read here would be under a key that is
 * a prefix of the real one.
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
 * Open a database with WHICHEVER DRIVER ITS BYTES CALL FOR, and prove it by
 * reading. Throws with a sentence naming the mistake; never returns a handle
 * that has not been read from.
 *
 * Deciding on the FILE rather than on whether `LAWHA_DB_KEY` happens to be set
 * is what lets this script cross the boundary in either direction — an
 * encrypted artefact installed over a plaintext live database, or the reverse
 * — instead of reporting one of those as "in use" because it opened the wrong
 * file with the wrong driver. Each caller applies its own policy on top; this
 * only answers "can it be opened at all, and how".
 *
 * `cipher` before `key` for the reason `src/db/index.ts` states in capitals,
 * and the probe read because SQLCipher answers `ok` to `PRAGMA key` for any
 * key at all — it has not touched a page yet, so a function that stopped after
 * the pragmas would call every key correct.
 */
const openByFormat = (file, key, options = {}) => {
  if (readsAsPlaintextSqlite(file)) {
    return new Database(file, options);
  }

  if (!key) {
    throw new Error(
      `${file} is not a plain SQLite database and LAWHA_DB_KEY is not set. ` +
        "Either it is ENCRYPTED and this needs the same LAWHA_DB_KEY the " +
        "server boots with (it is in lawha.env, which only reaches the " +
        "containers — export it for a run by hand), or it is DAMAGED; from " +
        "outside those look identical",
    );
  }

  const db = new CipherDatabase(file, options);

  try {
    db.pragma("cipher=sqlcipher");
    db.pragma(`key=${keyLiteral(key)}`);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    db.close();
    throw new Error(
      `LAWHA_DB_KEY does not open ${file}. To SQLite a wrong key and a ` +
        "damaged file look identical, so check LAWHA_DB_KEY against the key " +
        `this database was encrypted with (${error.message})`,
    );
  }

  return db;
};

/**
 * Opens a database file, proves it is a Lawha database that SQLite is happy
 * with, and returns its row counts. Used on the backup before anything moves
 * and again on the result afterwards, because "the copy landed" and "the copy
 * is readable" are different claims.
 */
const inspect = (file, label, shownAs = file) => {
  let db;
  try {
    db = openByFormat(file, dbKey);
  } catch (error) {
    // `shownAs` and not `file`, because for an `age`-wrapped artefact `file`
    // is the decrypted copy in `os.tmpdir()` — a path that is deleted on the
    // way out and that the operator never chose, never saw, and cannot go and
    // look at. Naming it sends them to a file that is not there to inspect a
    // failure about a file that is. The refusal below this one already gets
    // this right by naming `backupFile`; this one did not.
    fail(`cannot open the ${label} at ${shownAs}: ${error.message}`);
  }

  const integrity = db.pragma("integrity_check")[0]?.integrity_check;

  if (integrity !== "ok") {
    db.close();
    fail(`integrity_check on the ${label} said "${integrity}", not "ok"`);
  }

  const missing = COUNTED_TABLES.filter((table) => !tableExists(db, table));

  if (missing.length > 0) {
    db.close();
    fail(`the ${label} has no ${missing.join(", ")} table — wrong file?`);
  }

  const counts = COUNTED_TABLES.map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
  ]);

  db.close();
  return counts;
};

const report = (counts) => {
  for (const [table, n] of counts) {
    say(`lawha:   ${String(n).padStart(6)}  ${table}`);
  }
};

/**
 * `age`'s own format signature — same constant, same reasoning, as
 * `AGE_MAGIC` in `backup.mjs`. Detected by BYTES rather than by trusting the
 * `.db.age` filename convention: an operator can rename a file, and a backup
 * that fails to decrypt because it was never encrypted in the first place is
 * a confusing way to find that out.
 */
const AGE_MAGIC = Buffer.from("age-encryption.org/v1");

const looksEncrypted = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(AGE_MAGIC.length);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return bytesRead === AGE_MAGIC.length && header.equals(AGE_MAGIC);
  } catch (error) {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};

/**
 * Decrypt `ciphertext` with the identity (private key) at `identityPath`, by
 * shelling out to `age -d -i <identityPath>`.
 *
 * Deliberately a smaller mirror of `encryptToRecipient` in `backup.mjs` and
 * `src/lib/ageEncrypt.ts` — not an import of either, same reason both of
 * those give for not importing each other: this script runs under plain
 * `node`, and `src/` is TypeScript this process cannot load without a build
 * step `test:scripts` must not depend on existing. Every failure path
 * REJECTS; nothing below may resolve with the ciphertext, or with anything
 * that is not genuinely what `age -d` produced. A wrong key or a corrupted
 * archive must fail loudly here, not hand back garbage bytes for `inspect()`
 * to discover three lines later with a confusing "not a database" error.
 */
const decryptWithIdentity = (ciphertext, identityPath) =>
  new Promise((resolve, reject) => {
    const child = spawn("age", ["-d", "-i", identityPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const failDecrypt = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(message));
    };

    child.on("error", (error) => {
      failDecrypt(`could not start "age": ${error.message}`);
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    // Same ignore-and-let-close-report shape as `backup.mjs`'s encrypt side:
    // a wrong key makes `age` exit fast and close stdin from its end, which
    // would otherwise surface here as an unhandled EPIPE instead of the real
    // reason the `close` handler below reports.
    child.stdin.on("error", () => {});

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (signal) {
        failDecrypt(`age was killed by ${signal}`);
        return;
      }

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        failDecrypt(
          `age exited ${String(code)}${stderr ? ` — ${stderr}` : ""} — check ` +
            "that the identity is the PRIVATE key matching the recipient this " +
            "was encrypted to, and that the file is not corrupted",
        );
        return;
      }

      const plaintext = Buffer.concat(stdoutChunks);

      if (plaintext.length === 0 && ciphertext.length > 0) {
        failDecrypt("age exited 0 but produced no output");
        return;
      }

      settled = true;
      resolve(plaintext);
    });

    child.stdin.end(ciphertext);
  });

/** Every regular file under `dir`, recursively, as absolute paths. */
const walkFiles = (dir) => {
  const results = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stats = fs.statSync(full);
    if (stats.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (stats.isFile()) {
      results.push(full);
    }
  }
  return results;
};

const hasEncryptedFile = (dir) =>
  walkFiles(dir).some((file) => file.endsWith(".age"));

/**
 * Copy the blob mirror back into `LAWHA_FILES_DIR`'s layout, decrypting any
 * `.age` blob along the way.
 *
 * This script used to end with a note telling an operator to `cp -a` the
 * blobs back by hand. That advice is now WRONG whenever the mirror was taken
 * with `LAWHA_BACKUP_RECIPIENT` set (Task 4's `mirror_blobs`): a blob
 * mirrored under that regime is `age` ciphertext named `<id>.age`, and a
 * blind `cp -a` would plant that ciphertext straight into the live files
 * directory, where the server would serve it as an image and every browser
 * would show a broken picture — exactly the corrupted-images-directory
 * outcome this function exists to prevent.
 *
 * Blobs are immutable and content-addressed (`http/routes/files.ts` writes
 * them write-then-rename, never twice), so unlike the database there is no
 * WAL hazard and no move-aside needed: an overwrite here is a no-op in
 * substance, only ever the same bytes landing on the same name twice.
 */
const restoreBlobs = async (sourceDir, destDir, identityFile) => {
  const files = walkFiles(sourceDir);
  let copied = 0;
  let decrypted = 0;

  for (const sourcePath of files) {
    const relative = path.relative(sourceDir, sourcePath);
    const isEncryptedBlob = relative.endsWith(".age");
    const destRelative = isEncryptedBlob
      ? relative.slice(0, -".age".length)
      : relative;
    const destPath = path.join(destDir, destRelative);

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      if (isEncryptedBlob) {
        // `identityFile` is guaranteed non-null here: `hasEncryptedFile` on
        // this same directory is what decided, before any live database was
        // touched, whether an identity was required at all — but a key
        // being SUPPLIED is not proof it OPENS every blob (a mirror can hold
        // blobs encrypted to more than one recipient over a deployment's
        // life), so this can still fail per-file — hence the `try` around it.
        const plaintext = await decryptWithIdentity(
          fs.readFileSync(sourcePath),
          identityFile,
        );
        fs.writeFileSync(destPath, plaintext);
        decrypted += 1;
      } else {
        fs.copyFileSync(sourcePath, destPath);
        copied += 1;
      }
    } catch (error) {
      // Not a bare rethrow: the database has already been installed by the
      // time this runs, so a caller seeing only a rejection has no way to
      // tell "0 of 1000 blobs touched" from "999 of 1000, one bad file" —
      // very different things to act on. Progress is reported IN the
      // message because it is computed from a local counter that is lost
      // the moment this throws past the loop that has been counting it.
      throw new Error(
        `${copied + decrypted} of ${files.length} blob(s) restored; ` +
          `stopped at ${sourcePath}: ${error.message}`,
      );
    }
  }

  return { copied, decrypted };
};

/**
 * Long enough to ride out a momentary conflict, short enough that a refusal is
 * immediate on human timescales. Not zero: a busy handler is what tells a
 * transient contender apart from a server, and a server holds its locks for as
 * long as it is up, so no timeout can make a live one look idle.
 */
const CLAIM_TIMEOUT_MS = 1000;

/**
 * Take the database exclusively, and hand back the connection if it worked.
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` used to be the whole check here, on the
 * theory that a busy checkpoint means a live server. It does not. TRUNCATE
 * reports `busy` only when a transaction is IN FLIGHT; a connection that is
 * merely open — a server nobody is drawing on — holds no lock a checkpoint can
 * trip over, so it returned `busy: 0` and the restore went ahead underneath it.
 * Reproduced: a stand-in server opened the database in WAL mode, wrote nine
 * accounts and sat idle; `wal_checkpoint(TRUNCATE)` said `{"busy":0}`, this
 * script renamed the live file aside, copied a one-account backup in and exited
 * zero with no warning at all. The server carried on reading nine accounts
 * through its old descriptor and wrote a new board into the `-wal` that step 3
 * then unlinked. That is data loss, not a displaced file, and four documents
 * promised it could not happen.
 *
 * `locking_mode = EXCLUSIVE` is a check that actually detects it. In WAL mode
 * every attached connection holds a piece of the wal-index, whether or not it
 * is in a transaction, so the first transaction taken in exclusive locking mode
 * fails with SQLITE_BUSY while anybody else is attached. Measured in all four
 * states before it was shipped: BUSY with an idle connection open, BUSY with a
 * write transaction held, acquired once the connection closed, and — the one
 * that matters in the other direction — acquired over the `-wal` and `-shm` a
 * SIGKILLed process leaves behind, because a stale sidecar is not a running
 * server and must not read as one. In none of the refusing cases was a byte of
 * the live database touched.
 *
 * Two limits, written down rather than left to be discovered:
 *
 * - It cannot see an idle connection to a database in ROLLBACK-JOURNAL mode,
 *   because there genuinely is no lock to find; nothing can. The Lawha server
 *   sets `journal_mode = WAL` on every open (`src/db/index.ts`), so the
 *   deployment this protects is covered.
 * - A server that starts between this claim and the copy below is a race no
 *   in-process check can close. Stop the server; this is a backstop for
 *   forgetting to, not a substitute for it.
 *
 * `unreadable` is returned separately from `reason` because the two demand
 * different sentences and, before this, they collapsed into one. Opening an
 * ENCRYPTED live database with the plain driver succeeds and then fails on the
 * first page read, which arrived here as a busy-looking failure — so a keyed
 * deployment with nothing running at all would have been told "the database is
 * in use, stop the server first", and the operator's next move would have been
 * `--force`, which is the one flag that must never be reached for the wrong
 * reason. `openByFormat` above decides the driver from the file's own bytes so
 * that this question is answered honestly.
 */
const claimExclusively = (file) => {
  let db;

  try {
    db = openByFormat(file, dbKey, { timeout: CLAIM_TIMEOUT_MS });
  } catch (error) {
    return { db: null, reason: error.message, unreadable: true };
  }

  try {
    db.pragma("locking_mode = EXCLUSIVE");
    // The pragma alone proves nothing — exclusive locking mode is lazy, and the
    // locks are taken by the next transaction rather than by the pragma. A read
    // transaction is what forces the wal-index locks; the write transaction
    // then covers a rollback-mode file, where reads only take SHARED. Neither
    // writes a page: BEGIN IMMEDIATE takes the lock and nothing else, and the
    // ROLLBACK gives it straight back.
    db.exec("BEGIN; SELECT COUNT(*) FROM sqlite_master; COMMIT;");
    db.exec("BEGIN IMMEDIATE; ROLLBACK;");
  } catch (error) {
    db.close();
    return { db: null, reason: error.message };
  }

  return { db, reason: null };
};

/**
 * `LAWHA_DB_KEY` — SQLCipher on the database itself, mirroring `dbKey` in
 * `src/config.ts` down to the `|| null` so an explicit blank means the same as
 * unset. Read straight from the environment, and carried VERBATIM: a key this
 * script trimmed on the way past would open nothing, and the operator's only
 * evidence would be a value in `lawha.env` that looks right.
 *
 * This is NOT the `age` private key and must never be confused with it — see
 * the header comment. That one arrives only as `--identity` or on stdin, and
 * this script would be broken if it ever read it from here.
 */
const dbKey = process.env.LAWHA_DB_KEY || null;

const args = process.argv.slice(2).flatMap((arg) => {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
});

let backupFile = null;
let force = false;
let dbPath = process.env.LAWHA_DB_PATH || DEFAULT_DB_PATH;
let identityArg = null;
let filesArchiveDir = null;

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
  } else if (arg === "--force") {
    force = true;
  } else if (arg === "--identity") {
    i += 1;
    identityArg = args[i];
    if (!identityArg) {
      fail("--identity needs a path");
    }
  } else if (arg === "--files") {
    i += 1;
    filesArchiveDir = args[i];
    if (!filesArchiveDir) {
      fail("--files needs a path");
    }
  } else if (arg.startsWith("-")) {
    process.stderr.write(USAGE);
    fail(`unknown option "${arg}"`);
  } else if (backupFile === null) {
    backupFile = arg;
  } else {
    process.stderr.write(USAGE);
    fail(`unexpected argument "${arg}"`);
  }
}

if (!backupFile) {
  process.stderr.write(USAGE);
  fail("no backup file given");
}

/**
 * Checked after the argument loop, not before it, so `--help` still answers a
 * question that has nothing to do with the key — and before anything is read
 * or moved, because a key the server would refuse is a configuration mistake
 * and not a restore that half-happened.
 */
if (dbKey !== null && dbKey.length < MIN_DB_KEY_LENGTH) {
  fail(
    `LAWHA_DB_KEY is ${dbKey.length} characters and the server refuses to ` +
      `boot with anything under ${MIN_DB_KEY_LENGTH} (src/config.ts). ` +
      "Restoring with it would install a database only a server that will " +
      "not start could open. Nothing has been changed.",
  );
}

/**
 * THIS SCRIPT MUST LOAD AND RUN WITH THE CIPHER DRIVER ABSENT, for the reason
 * `backup.mjs` records at length above its own copy of this function:
 * `docker-compose.yml` bind-mounts `./lawha-server/scripts` into a container
 * whose `node_modules` comes from an image that may predate the dependency, so
 * a top-level `import` of the cipher driver fails before the first line of the
 * module body runs — including `--help`, including every refusal below.
 *
 * The recovery path mattering MORE than the backup path is why this is spelled
 * out twice rather than shared: an operator reaching for `restore.mjs` is
 * already having a bad day, and a module-resolution stack trace is the worst
 * possible thing to hand them. When it does fail, it says which command fixes
 * it.
 */
const loadCipherDriver = async () => {
  try {
    ({ default: CipherDatabase } = await import(
      "better-sqlite3-multiple-ciphers"
    ));
  } catch (error) {
    fail(
      "LAWHA_DB_KEY is set, but this environment has no " +
        `better-sqlite3-multiple-ciphers to open the database with (${error.message}).\n` +
        "lawha: The scripts directory is bind-mounted from the working tree " +
        "while node_modules\n" +
        "lawha: comes from the image, so the two can disagree. Rebuild it: " +
        "`docker compose build lawha-backup lawha-server`.\n" +
        "lawha: Nothing has been changed.",
    );
  }
};

if (dbKey !== null) {
  await loadCipherDriver();
}

backupFile = path.resolve(backupFile);
dbPath = path.resolve(dbPath);

if (identityArg) {
  identityArg = path.resolve(identityArg);
  if (!fs.existsSync(identityArg)) {
    fail(`no such identity file: ${identityArg}`);
  }
}

if (filesArchiveDir) {
  filesArchiveDir = path.resolve(filesArchiveDir);
  if (!fs.existsSync(filesArchiveDir)) {
    fail(`no such blobs directory: ${filesArchiveDir}`);
  }
}

if (backupFile === dbPath) {
  fail("the backup and the database are the same file");
}

if (!fs.existsSync(backupFile)) {
  fail(`no such backup: ${backupFile}`);
}

// A backup taken by something other than `backup.mjs` may still be in WAL mode
// with its pages in a sidecar. Copying such a file alone installs the 4KB
// header and nothing else — the original disaster exactly — so refuse rather
// than restore an empty database that looks like a success. Meaningless (and
// harmless) for an encrypted `.db.age` candidate, which cannot acquire a real
// `-wal` sidecar of its own.
const backupWal = `${backupFile}-wal`;

if (fs.existsSync(backupWal) && fs.statSync(backupWal).size > 0) {
  fail(
    `${backupWal} is not empty, so ${path.basename(
      backupFile,
    )} is only part of a database. Checkpoint it first, or take a fresh backup with \`yarn --cwd lawha-server backup\`.`,
  );
}

/**
 * Whether a private key is going to be needed at all, decided ONCE, before
 * anything is read from stdin and before the live database is touched. Two
 * independent things can require it — the backup artefact itself, and any
 * `.age` blob under `--files` — and checking both up front means a restore
 * that cannot finish fails before it starts, rather than after copying most
 * of a blob mirror.
 */
const backupIsEncrypted = looksEncrypted(backupFile);
const identityNeeded =
  backupIsEncrypted ||
  (filesArchiveDir !== null && hasEncryptedFile(filesArchiveDir));

/**
 * Resolved once, here — never from `lawha.env`, a config value, or anything
 * else the container might see. `--identity <path>` is the explicit form;
 * absent that, and only when one is actually needed, the key is read from
 * stdin as raw bytes (exactly what `age-keygen` writes, or the "AGE-SECRET-
 * KEY-1…" line alone) and staged to a private temp file for `age -i`, because
 * `age` itself needs a real path, not a pipe. That temp file is the one piece
 * of key material this script ever writes to disk, and it is removed
 * unconditionally on exit — see the `process.on("exit", …)` handler below —
 * regardless of whether the run succeeded, failed, or was interrupted.
 */
let identityFile = null;
let identityTempFile = null;

if (identityArg) {
  identityFile = identityArg;
} else if (identityNeeded) {
  const NEEDS_KEY_MESSAGE =
    "this restore needs the private key that matches the recipient the " +
    "backup (or its blobs) was encrypted to — pass one with " +
    "--identity <path>, or pipe an age identity on stdin";

  /**
   * The bare invocation `yarn --cwd lawha-server restore <file>` with no
   * `--identity` is documented in `README.md`. Run that against a `.db.age`
   * at a real terminal and, without this check, `fs.readFileSync(0, "utf8")`
   * below blocks waiting for EOF on a stdin nobody is ever going to close: no
   * output, no error, no exit — verified against a real pty, not just the
   * test harness, whose `spawnSync` with no `input` closes stdin immediately
   * and so never exercises this branch at all. A failure mode where nothing is
   * reported is worse than one where something is. Refuse immediately instead
   * of reading.
   */
  if (process.stdin.isTTY) {
    fail(NEEDS_KEY_MESSAGE);
  }

  let material;
  try {
    material = fs.readFileSync(0, "utf8");
  } catch (error) {
    material = "";
  }

  if (!material.trim()) {
    fail(NEEDS_KEY_MESSAGE);
  }

  identityTempFile = path.join(
    os.tmpdir(),
    `lawha-restore-identity-${crypto.randomBytes(8).toString("hex")}`,
  );
  fs.writeFileSync(identityTempFile, material, { mode: 0o600 });
  identityFile = identityTempFile;
}

const now = stamp(new Date());
const aside = `${dbPath}.pre-restore-${now}`;
const wal = `${dbPath}-wal`;
const shm = `${dbPath}-shm`;
const hadDatabase = fs.existsSync(dbPath);
const installingTmp = `${dbPath}.installing-${now}`;

/**
 * The one recovery sentence, said the same way by whichever of two paths
 * reaches it — a signal (see the header's SIGNAL HANDLING section for why
 * that path is unreachable today) or a plain I/O failure between the
 * move-aside and the install (the one that is actually reachable: a full
 * disk, a permissions error, `aside` and `dbPath` ending up on different
 * filesystems). Factored out after review found the sentence existed on
 * only the unreachable path — the reachable failure produced a raw
 * exception instead, with `lawha.db` simply gone and nothing printed about
 * where its contents went.
 */
const asideRecoveryAdvice = () =>
  `your data is safe at ${aside}; move it back over ${dbPath} yourself, or ` +
  "re-run this restore, before starting the server.";

/**
 * Where this run stands, for the interrupt handler below to describe
 * honestly. `"before-move"` covers everything up to and including decrypting
 * and verifying the backup — the live database has not been touched, so an
 * interrupt here changes nothing. `"moved-aside"` starts the instant the old
 * database is renamed to `aside` and lasts until the new one is fully
 * installed; an interrupt in this window is the one that matters, because
 * `dbPath` may briefly not exist or not yet hold the new data. `"installed"`
 * is set only after the atomic rename onto `dbPath` completes.
 */
let restorePhase = "before-move";
/** The plaintext this process decrypted, if the backup was encrypted. */
let decryptedTemp = null;

/**
 * Whatever scratch this run created that must never outlive it, removed
 * unconditionally — success, `fail()`, or a signal, all funnel through
 * `process.exit()` and this fires for every one of them. None of these three
 * names is ever `dbPath` or `aside`, so this can never touch the database
 * itself, restored or not.
 *
 * Each removal gets its OWN `try`, found while hand-verifying the install
 * failure path below: `{ force: true }` on `fs.rmSync` suppresses ENOENT
 * (the file never existed — the common, harmless case) but NOT ENOTDIR, and
 * `installingTmp` can legitimately fail to exist for exactly that reason —
 * an intermediate path segment that turned out to be a plain file, the same
 * condition that made the install itself fail a moment earlier. Without
 * this, the operator saw the correct, actionable install-failure message
 * print — immediately followed by a second, unrelated raw stack trace from
 * THIS handler, which reads as a fresh crash on top of the one already
 * explained rather than as this process quietly cleaning up after itself.
 */
process.on("exit", () => {
  for (const scratch of [decryptedTemp, identityTempFile, installingTmp]) {
    if (scratch) {
      try {
        fs.rmSync(scratch, { force: true });
      } catch {
        // Best-effort only. A stray scratch file is a loose end to clean up
        // by hand, never a reason to mask — or, as found here, itself
        // crash past — the real failure this process is already exiting to
        // report.
      }
    }
  }
});

/**
 * See the header comment's SIGNAL HANDLING section for the full story,
 * including which branch below actually fires and which does not. Short
 * version: with no handler, these three signals' default disposition —
 * terminate — is delivered by the kernel and can strike between any two
 * instructions, synchronous code or not. Registering a handler replaces
 * that with a queued JS callback instead, which is what makes it possible
 * for the fully-synchronous move-aside → install stretch below to run to
 * completion before any of these three ever execute — not "uninterruptible"
 * in the sense of the branch below always being reached, but in the sense
 * that nothing there can be split mid-way by one.
 */
const INTERRUPTS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

for (const [signal, number] of Object.entries(INTERRUPTS)) {
  process.on(signal, () => {
    if (restorePhase === "moved-aside") {
      process.stderr.write(
        `lawha: interrupted by ${signal} — the live database was moved aside ` +
          `to ${aside} and NOTHING has been installed at ${dbPath} yet.\n` +
          `lawha: ${asideRecoveryAdvice()}\n`,
      );
    } else if (restorePhase === "installed") {
      process.stderr.write(
        `lawha: interrupted by ${signal} after the restore was installed at ` +
          `${dbPath} — verification may not have finished; compare the two ` +
          "sets of counts printed above by hand.\n",
      );
    } else {
      process.stderr.write(
        `lawha: interrupted by ${signal} before anything was touched; nothing ` +
          "was changed.\n",
      );
    }
    // 128+n is what a shell reports for a signalled process, matching
    // backup.mjs's own handlers.
    process.exit(128 + number);
  });
}

let verifyTarget = backupFile;

if (backupIsEncrypted) {
  say(`lawha: decrypting ${backupFile}`);

  let plaintext;
  try {
    plaintext = await decryptWithIdentity(
      fs.readFileSync(backupFile),
      identityFile,
    );
  } catch (error) {
    fail(`could not decrypt ${backupFile}: ${error.message}`);
  }

  decryptedTemp = path.join(
    os.tmpdir(),
    `lawha-restore-decrypted-${crypto.randomBytes(8).toString("hex")}.db`,
  );
  fs.writeFileSync(decryptedTemp, plaintext, { mode: 0o600 });
  verifyTarget = decryptedTemp;
}

/**
 * A plaintext artefact aimed at a keyed deployment, refused before anything
 * moves.
 *
 * Installing it would leave a database the server declines to open at all —
 * `describeFailure` in `src/db/index.ts` answers exactly this state with
 * "LAWHA_DB_KEY is set, but this file is NOT encrypted" — which the operator
 * would discover on the next `docker compose up`, with their live database
 * already moved aside. Refusing costs nothing at this point.
 *
 * The recipe is spelled out rather than described because whoever is reading
 * it is mid-restore and should not have to compose two commands. `encrypt-db`
 * is named instead of this script growing its own conversion: it already does
 * that job, keeps the plaintext original, verifies the result against the
 * source's counts and schema, and refuses on any mismatch. A second, thinner
 * copy of that inside the one script that must not be clever is exactly the
 * trade this whole file is written against.
 *
 * The reverse mismatch — an encrypted artefact and no key — is caught by
 * `inspect` above, through `openByFormat`, which names LAWHA_DB_KEY.
 */
if (dbKey !== null && readsAsPlaintextSqlite(verifyTarget)) {
  fail(
    `LAWHA_DB_KEY is set, but ${backupFile} is a PLAIN, unencrypted SQLite ` +
      "database. Installing it would leave a database this deployment's " +
      "server refuses to open. Nothing has been changed.\n" +
      "lawha:\n" +
      "lawha: Restore it WITHOUT the key, then encrypt what landed:\n" +
      // The flags THIS run was given are carried through, and leaving them
      // out was not cosmetic: an `age`-wrapped artefact restored without
      // `--identity` cannot be decrypted at all, so the first line of a
      // spelled-out recovery would have failed on its own. A recipe an
      // operator can paste and watch fail is worse than no recipe, because
      // the next thing they doubt is the artefact.
      `lawha:     LAWHA_DB_KEY= yarn --cwd lawha-server restore ${backupFile} --db ${dbPath}` +
      (identityArg
        ? ` --identity ${identityArg}`
        : // Piped on stdin rather than passed as a path, so there is no path
          // to quote back — the placeholder is what the blob-restore failure
          // further down already prints for the same situation.
          identityNeeded
        ? " --identity <path>"
        : "") +
      (filesArchiveDir ? ` --files ${filesArchiveDir}` : "") +
      "\n" +
      `lawha:     LAWHA_DB_KEY=… yarn --cwd lawha-server encrypt-db --db ${dbPath}`,
  );
}

say(`lawha: verifying ${backupFile}`);
const backupCounts = inspect(verifyTarget, "backup", backupFile);
report(backupCounts);

if (hadDatabase) {
  if (fs.existsSync(aside)) {
    fail(`${aside} already exists; wait a second and run it again`);
  }

  const claim = claimExclusively(dbPath);

  if (claim.unreadable && !force) {
    // Its own branch, and its own sentence. This is not "somebody else has it
    // open" — it is "this cannot be read at all", and telling an operator to
    // stop a server that is already stopped sends them straight to `--force`,
    // which is the one flag that must never be reached for the wrong reason.
    fail(
      `the existing database at ${dbPath} cannot be read: ${claim.reason}.\n` +
        "lawha: Nothing has been changed. Fix that first — or, if you mean " +
        "to replace it\n" +
        "lawha: unread, re-run with --force, which will keep it aside " +
        "untouched either way.",
    );
  }

  if (!claim.db && !force) {
    fail(
      `the database at ${dbPath} is in use — stop the server first ` +
        "(`docker compose stop lawha-server`), then run this again. " +
        "Restoring under a live process leaves it writing to a database that is no longer there. " +
        `(${claim.reason}) ` +
        "--force overrides this and you almost certainly do not want it.",
    );
  }

  /**
   * Under `--force` the claim failed and there is no connection to reuse, so
   * the checkpoint gets an ordinary one. It is still worth doing: it is what
   * puts the pages into the file about to be renamed aside.
   *
   * Unless the file cannot be opened at all, which `--force` now also reaches
   * — an encrypted database whose key has been lost is precisely a thing
   * someone restores over. There is no checkpoint to take, so it is skipped
   * and said out loud; the sidecar block below then keeps a non-empty `-wal`
   * beside the file it belongs to rather than deleting it, which is the
   * behaviour that makes the kept copy still openable by whoever finds the
   * key later.
   */
  let checkpoint = { busy: 0 };
  let live = claim.db;

  if (!live) {
    try {
      live = openByFormat(dbPath, dbKey);
    } catch (error) {
      process.stderr.write(
        `lawha: WARNING — ${dbPath} could not be opened to checkpoint it ` +
          `(${error.message}); it will be kept aside exactly as it is, with ` +
          "any -wal beside it.\n",
      );
    }
  }

  if (live) {
    [checkpoint] = live.pragma("wal_checkpoint(TRUNCATE)");
    live.close();
  }

  if (checkpoint?.busy !== 0 && !force) {
    fail(
      `the database at ${dbPath} is in use — stop the server first ` +
        "(`docker compose stop lawha-server`), then run this again. " +
        "Restoring under a live process leaves it writing to a database that is no longer there. " +
        "--force overrides this and you almost certainly do not want it.",
    );
  }

  fs.renameSync(dbPath, aside);
  restorePhase = "moved-aside";
  say(`lawha: moved the existing database aside as ${aside}`);
} else {
  say(
    `lawha: no existing database at ${dbPath} — restoring into an empty spot`,
  );
}

/**
 * Sidecars are handled in BOTH branches, and that is the whole point of this
 * block sitting outside the `if` above rather than inside it.
 *
 * `backup.mjs` already names this hazard from the archive side — "leaving a
 * stray `-wal` beside a deleted `.db` is how a future restore picks up somebody
 * else's pages" — and the guard on the backup ARTEFACT is a few lines up this
 * file. The target side had no such guard, and the hole is not theoretical:
 * with `lawha.db` deleted by hand, or after this script was interrupted between
 * the rename above and this block, a foreign `-wal` sat in the directory and
 * SQLite RECOVERED it into the freshly copied backup. WAL frame checksums are
 * seeded from the WAL header's own salt, so frames from an unrelated database
 * validate perfectly, and `pagerOpenWalIfPresent` opens a `-wal` it finds next
 * to a rollback-mode file rather than ignoring it. Reproduced: a one-account
 * backup restored beside a five-account orphan printed "1 users" for the
 * artefact and "5 users" for the result and exited zero.
 *
 * Nothing is deleted that could hold pages. An orphan is renamed out of the way
 * with a name that says what it is, exactly as the live database is.
 */
if (fs.existsSync(wal)) {
  if (!hadDatabase) {
    const orphan = `${dbPath}.orphaned-wal-${now}`;
    if (fs.existsSync(orphan)) {
      fail(`${orphan} already exists; wait a second and run it again`);
    }
    fs.renameSync(wal, orphan);
    process.stderr.write(
      `lawha: WARNING — ${wal} was there with no database beside it and was moved to ${orphan}.\n` +
        "lawha: Restoring on top of it would have recovered its pages into the backup you are installing.\n" +
        "lawha: It belongs to a database that was deleted or to an interrupted restore; check the .pre-restore-* files before removing it.\n",
    );
  } else if (fs.statSync(wal).size === 0) {
    // Truly orphaned: the checkpoint above folded every page into the file
    // that has just been renamed, so this holds nothing.
    fs.unlinkSync(wal);
  } else {
    // The checkpoint did not empty it, so it still holds pages belonging to
    // the database we just moved. Renaming keeps the pair together and
    // openable; deleting it would be the data loss this script exists to
    // prevent. SQLite derives the sidecar name from the main file, so the
    // suffix has to match exactly.
    fs.renameSync(wal, `${aside}-wal`);
    process.stderr.write(
      `lawha: WARNING — ${wal} still held pages and was kept as ${aside}-wal\n`,
    );
  }
}

if (fs.existsSync(shm)) {
  // Shared-memory index only. SQLite rebuilds it from the `-wal` on the next
  // open, so there is nothing in it to preserve.
  fs.unlinkSync(shm);
}

/**
 * Copied to a staging name and renamed onto `dbPath`, never written to the
 * final name directly — see the header comment's step 5. `fs.copyFileSync`
 * has no atomicity guarantee; `fs.renameSync` on the same filesystem does,
 * and `installingTmp` sits beside `dbPath` for exactly that reason.
 *
 * Wrapped in its own `try` — mkdir included — because this whole step is the
 * failure in this window that is actually reachable — a full disk, a
 * permissions error, an intermediate path segment that turns out to be a
 * plain file — where a signal is not (see the header's SIGNAL HANDLING
 * section). Before this wrapping, that failure had no handler above it and
 * surfaced as a raw exception: exit 1, a V8 stack trace on stderr,
 * `lawha.db` gone, and the recovery sentence this file already wrote for
 * exactly this state reachable only from a signal handler that could never
 * fire here. Same message, both paths now — `asideRecoveryAdvice()` is
 * shared with the signal handler above for exactly that reason.
 */
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(verifyTarget, installingTmp);
  fs.renameSync(installingTmp, dbPath);
} catch (error) {
  fail(
    `could not install the restored database: ${error.message}\n` +
      (hadDatabase
        ? `lawha: ${asideRecoveryAdvice()}`
        : `lawha: nothing existed at ${dbPath} before this ran, so nothing was lost.`),
  );
}

restorePhase = "installed";

say(`lawha: restored ${backupFile}`);
say(`lawha:       to ${dbPath}`);
const restoredCounts = inspect(dbPath, "restored database");
report(restoredCounts);

/**
 * The two count blocks are printed a dozen lines apart and, until this, nothing
 * subtracted them — which is how a restore could print "1 users" for the
 * artefact and "5 users" for the result and still call itself a success. A
 * `cp` of one file to another cannot change a row count, so any difference here
 * means what landed is not what was verified: recovered sidecar frames, a short
 * copy, or something writing to the target while this ran. All three are
 * failures, and none of them may exit zero.
 */
const drift = backupCounts
  .map(([table, n], i) => [table, n, restoredCounts[i]?.[1]])
  .filter(([, n, landed]) => landed !== n);

if (drift.length > 0) {
  fail(
    "the restored database does not match the backup — " +
      `${drift
        .map(
          ([table, n, landed]) => `${table}: backup ${n}, restored ${landed}`,
        )
        .join("; ")}. ` +
      "A copy cannot change a row count, so something else contributed pages to it. " +
      (hadDatabase
        ? `Your data is untouched at ${aside}; move it back over ${dbPath} and investigate before running this again.`
        : `Do NOT start the server against ${dbPath}; investigate what else is writing there.`),
  );
}

/**
 * Same variable `backup.mjs` reads for the equivalent purpose in its own
 * closing note, not a name invented for this file — an operator who set
 * `LAWHA_FILES_DIR` to move blobs off the default path gets restore.mjs
 * agreeing with them instead of silently writing to a location nothing
 * else on the deployment reads from. Falls back to the same default
 * `LAWHA_FILES_DIR` itself defaults to (`src/config.ts`): a `files` sibling
 * of the database.
 */
const destFilesDir =
  process.env.LAWHA_FILES_DIR || path.join(path.dirname(dbPath), "files");

if (filesArchiveDir) {
  say(`lawha: restoring blobs from ${filesArchiveDir}`);
  try {
    const { copied, decrypted } = await restoreBlobs(
      filesArchiveDir,
      destFilesDir,
      identityFile,
    );
    say(
      `lawha: restored ${copied + decrypted} blob(s) to ${destFilesDir}` +
        (decrypted > 0 ? ` (${decrypted} decrypted)` : ""),
    );
  } catch (error) {
    fail(
      `blob restore failed: ${error.message}\n` +
        "lawha: the database above was already restored and verified — that part is done and safe.\n" +
        `lawha: re-run with --files ${filesArchiveDir}` +
        (identityArg ? ` --identity ${identityArg}` : " --identity <path>") +
        " to pick up where this left off — already-restored blobs are simply written again, not lost.",
    );
  }
} else {
  say("lawha:");
  say(
    "lawha: uploaded blobs are separate and were NOT restored. A plain `cp -a`",
  );
  say("lawha: is only safe if none of them were ever mirrored with a backup");
  say(
    "lawha: recipient configured — otherwise some are `age` ciphertext and a",
  );
  say(
    "lawha: blind copy would plant unreadable files where your images belong.",
  );
  say(
    `lawha: restore them properly with: yarn --cwd lawha-server restore ${path.basename(
      backupFile,
    )} --files <archive>/files [--identity <path>]`,
  );
}

if (dbKey !== null) {
  // The one way a successful restore can still leave an unbootable server:
  // this ran with LAWHA_DB_KEY exported on the host, and lawha.env holds a
  // DIFFERENT value. Everything above passed — the artefact opened, the counts
  // matched — because everything above used the exported one. Task 6 makes the
  // server refuse loudly rather than present an empty database, so this is a
  // pointer to the message they will see, not a silent loss.
  say("lawha:");
  say(
    "lawha: what was installed is SQLCipher-encrypted. The server opens it with",
  );
  say(
    "lawha: LAWHA_DB_KEY from lawha.env — check that it is the same value you",
  );
  say("lawha: just restored with, or it will refuse to start and say so.");
}

say("lawha:");
say("lawha: start the server, then check `docker compose logs lawha-server`.");
say(
  "lawha: it must NOT print a first-boot administrator banner — that banner means zero accounts,",
);
say("lawha: which means it is not looking at your data.");
