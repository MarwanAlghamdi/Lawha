/**
 * Online backup of the Lawha database — one that actually contains the data.
 *
 *   yarn --cwd lawha-server backup <directory> [--keep N] [--db <path>]
 *
 * Four facts decided the shape of this file and every one of them was learned
 * the expensive way:
 *
 * 1. THE DATABASE IS IN WAL MODE. `lawha.db` on disk is usually a 4KB header
 *    while every table lives in `lawha.db-wal`. `cp lawha.db elsewhere` yields
 *    a database with ZERO tables — measured on this deployment, not theorised.
 *    It restores silently: the server finds no accounts, prints a first-boot
 *    administrator banner, and every board is gone.
 * 2. `tar czf` over the data directory has the opposite failure. It catches
 *    the `-wal` mid-transaction, so the archive can hold a `-wal` that
 *    disagrees with the `.db` beside it, and you find out at restore time.
 * 3. THE RUNTIME IMAGE IS `node:22-slim`, which ships no `sqlite3` CLI, so
 *    `.backup` from a shell is not available even inside the container.
 * 4. SQLite's ONLINE BACKUP API (`db.backup()`, which better-sqlite3 exposes)
 *    answers all three. It is safe against a database another process is
 *    writing — it takes a read lock per page batch rather than freezing the
 *    server — and it produces ONE checkpointed file with no sidecar anybody
 *    has to remember to restore alongside it.
 *
 * A backup nobody verified is not a backup, so the result is opened,
 * `PRAGMA integrity_check`ed and counted before this script will call it a
 * success, and a file that fails either test is renamed `.rejected` rather
 * than left in the directory looking like a restore candidate.
 *
 * Nothing carries the name `lawha-<stamp>.db` until it has passed all of that.
 * The copy is written as `lawha-<stamp>.db.partial` and renamed into the
 * namespace at the end, because the previous version handed the final name
 * straight to `backup()` and the online backup API neither unlinks nor
 * truncates on failure. Reproduced: SIGINT part-way through — an operator
 * interrupting a long backup, exit 130, far more reachable than a crash — left
 * a partial file sitting at its final name with a `-journal` beside it, and the
 * next run's `--keep 2` deleted BOTH genuine backups in order to keep it,
 * because retention sorted names and never opened one. The partial passes
 * `integrity_check` and has ZERO tables, the hot journal having rolled it back,
 * so an integrity check alone does not catch it either. Retention now verifies
 * every candidate before it will count one, and refuses to delete a backup it
 * has read in favour of one it has not.
 *
 * ENCRYPTION, if `LAWHA_BACKUP_RECIPIENT` (an `age1…` public key) is set, is
 * the very last thing that happens to the artefact — after `integrity_check`,
 * after the row counts, never before. A corrupt file encrypted promptly is
 * still corrupt; the verification above is the only reason to trust the bytes
 * being encrypted at all. The result is `lawha-<stamp>.db.age`, written via
 * its own `.age.partial` temporary name for the same reason the plaintext
 * copy is: nothing wears a finished artefact's name until it IS finished. The
 * plaintext temporary file is deleted once the ciphertext lands, because a
 * recipient being configured means plaintext must never sit in the archive —
 * not even under a name retention does not recognise. Retention's own regex,
 * `BACKUP_NAME` below, only ever matched `lawha-<stamp>.db` — extended here
 * with `AGE_BACKUP_NAME` so the `.age` form is counted and pruned too. Without
 * that second pattern retention would keep deleting the plaintext backups it
 * can see and never touch the encrypted ones sitting right beside them: the
 * archive grows forever and the disk fills, quietly, because every run still
 * exits 0. `age` is never imported from `src/lib/ageEncrypt.ts` here — same
 * reason `DEFAULT_DB_PATH` below is a duplicate rather than an import: this
 * script runs under plain `node`, and the compiled `dist/lib/ageEncrypt.js`
 * that mirrors it is a build artefact that `test:scripts` must not depend on
 * existing.
 *
 * LAWHA_DB_KEY, if the LIVE database is SQLCipher-encrypted, changes how the
 * copy is made and nothing else about the order above. The source is opened
 * with `better-sqlite3-multiple-ciphers` and the same `cipher`-then-`key`
 * pragmas `src/db/index.ts` uses, and the copy is made with `VACUUM INTO`
 * rather than `db.backup()`.
 *
 * That substitution is forced, not preferred. The online backup API creates
 * its destination itself, with no key, and SQLite refuses the pairing outright:
 * "backup is not supported with incompatible source and target databases" —
 * measured, and the reason every backup path in this project was unusable the
 * day `LAWHA_DB_KEY` shipped. It failed LOUDLY, which is the good half; the
 * API never wrote a plaintext copy of an encrypted database.
 *
 * `VACUUM INTO` carries the source's cipher and key across to the target in
 * SQLite3 Multiple Ciphers — measured against this exact driver, from a
 * separate process, against a live WAL database with every row still in the
 * `-wal`: the artefact's header is not `SQLite format 3`, it opens with the
 * key and refuses any other, `integrity_check` is `ok`, its rows are all
 * there, it lands in `journal_mode = delete` with no sidecars, and the live
 * database and both its sidecars were untouched byte for byte.
 *
 * **The artefact is therefore ciphertext from its first byte, and there is no
 * moment at which a plaintext copy exists on disk.** That is the constraint
 * this design was chosen for. Encrypting a plaintext copy after the fact would
 * have been simpler and would have put a complete, readable database in the
 * archive directory for as long as the encryption took — which is exactly the
 * leak an operator turns `LAWHA_DB_KEY` on to prevent, and it must not depend
 * on `LAWHA_BACKUP_RECIPIENT` being set as well, because the two halves of
 * this feature are independent by design.
 *
 * Verification is unchanged in substance and re-pointed in mechanism: the
 * artefact is opened WITH THE KEY and `integrity_check`ed and counted, because
 * an artefact that is verified without being read is not verified.
 *
 * WHAT THIS DOES NOT COVER: the uploaded blobs under `LAWHA_FILES_DIR`, or the
 * `config/` mirror (`lawha.env`, `certs/`). They are immutable files, not a
 * WAL database, so a plain `cp -a` is a correct tool for them in a way it is
 * not for `lawha.db` — but "immutable" is not "encrypted": ADR 0012 removed
 * the client-side encryption this comment used to claim covered them, and a
 * board's images are exactly as plaintext on disk as its scene JSON is. This
 * script prints a reminder about the blobs on every run rather than letting
 * the omission be discovered during a restore.
 *
 * Under `docker compose`, `docker/lawha-backup.sh` is what actually mirrors
 * both — `mirror_blobs`/`mirror_config` there, not this file — and, since
 * that script grew its own `age` calls, ALSO encrypts both when
 * `LAWHA_BACKUP_RECIPIENT` is set, blobs once on first copy, config on every
 * run. This script's ignorance of `config/` and the blobs is real only for
 * someone running `yarn --cwd lawha-server backup` by hand outside Docker,
 * which is exactly the case the reminder below is for.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

/**
 * The cipher driver, loaded LAZILY and only when `LAWHA_DB_KEY` is set — see
 * `loadCipherDriver` below. A top-level `import` of it here took the running
 * deployment's scheduled backup down the moment it was written, and the reason
 * is worth the whole of that comment.
 */
let CipherDatabase = null;

/**
 * Mirrors the default in `src/config.ts`. Duplicated rather than imported
 * because this script must run under plain `node`: `src/` is TypeScript and
 * `tsx` is a devDependency that never reaches the runtime image. `--db` and
 * `LAWHA_DB_PATH` are the escape hatches if the two ever drift.
 */
const DEFAULT_DB_PATH = "./lawha-data/lawha.db";

/**
 * Must equal `MIN_DB_KEY_LENGTH` in `src/config.ts`, and a test compares the
 * two directly rather than leaving them as independent literals — same
 * arrangement, and the same reason, as `encrypt-db.mjs`. A key this accepts
 * and the server refuses would produce an archive full of artefacts that only
 * a server which will not boot could ever open.
 */
const MIN_DB_KEY_LENGTH = 16;

/**
 * The first sixteen bytes of every unencrypted SQLite file, exactly as
 * `SQLITE_MAGIC` in `src/db/index.ts`. The NUL is `\0` rather than a literal
 * for the reason recorded there: a raw NUL makes git treat the file as binary
 * and the diff stops being reviewable.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * The four tables an operator can recognise their own deployment in. `users`
 * matters most: zero accounts is precisely what the disaster looked like, and
 * a backup whose `users` table is missing entirely is not a Lawha database at
 * all — almost always a `--db` pointed at the wrong file.
 */
const COUNTED_TABLES = ["users", "boards", "board_scenes", "files"];

const USAGE =
  "usage: yarn --cwd lawha-server backup <directory> [--keep N] [--db <path>]\n";

const fail = (message) => {
  process.stderr.write(`lawha: ${message}\n`);
  process.exit(1);
};

const say = (message) => process.stdout.write(`${message}\n`);

/**
 * Observed while rehearsing a restore: `… backup ~/lawha-backups | head -8`
 * closes stdout part-way through, node raises EPIPE on the next write, and an
 * unhandled EPIPE kills the process with a non-zero status — reporting failure
 * for a backup that had already been written and verified. That is precisely
 * the wrong signal for the one thing a cron wrapper reads. A broken pipe is
 * not a failure of the work; any other write error still is, so it is
 * re-thrown rather than swallowed.
 */
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

/**
 * Local time, and the format is load-bearing: `lawha-YYYYMMDD-HHMMSS.db` sorts
 * chronologically as a plain string, which is what lets retention below pick
 * the newest N with a lexicographic sort and no date parsing.
 */
const stamp = (date) => {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

const BACKUP_NAME = /^lawha-\d{8}-\d{6}\.db$/;

/** The encrypted sibling of `BACKUP_NAME` — see the header comment. */
const AGE_BACKUP_NAME = /^lawha-\d{8}-\d{6}\.db\.age$/;

const tableExists = (db, name) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;

/**
 * `key='…'` with the passphrase escaped as a SQL string literal — the same
 * function, character for character, as `keyPragma` in `src/db/index.ts` and
 * `keyLiteral` in `encrypt-db.mjs`. The doubling is the whole of the safety; a
 * key containing a `'` would otherwise terminate the literal early and this
 * script would read the database under a key that is a prefix of the real one.
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
 * Open a SQLCipher file the way `src/db/index.ts` opens the live database, and
 * prove it by reading. Returns the connection, or null if the key does not
 * open it.
 *
 * The read is not ceremony: SQLCipher answers `ok` to `PRAGMA key` for any
 * value at all, because no page has been touched yet, so a function that
 * stopped after the pragmas would report every key as correct. `cipher` comes
 * before `key` because the key is interpreted by whichever scheme is selected
 * at the moment it is set, and this driver's default is chacha20.
 */
const openEncrypted = (file, key, options = {}) => {
  let db;
  try {
    db = new CipherDatabase(file, options);
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

/**
 * Every file SQLite can put beside a database file. `-journal` is the addition:
 * retention only ever knew about `""`, `-wal` and `-shm`, so the rollback
 * journal an interrupted backup leaves outlived the file it belonged to and
 * stayed in the archive directory forever.
 */
const SIDECARS = ["", "-wal", "-shm", "-journal"];

const removeWithSidecars = (file) => {
  for (const suffix of SIDECARS) {
    const target = `${file}${suffix}`;
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
};

/**
 * A retention candidate, opened read-only with whichever driver it needs.
 *
 * The key first, then plain — see `isVerifiedBackup` below for why the plain
 * fallback exists rather than being a hole in the check. Both are read-only,
 * so neither can modify the evidence retention is deciding on, and neither can
 * create the `-shm` a WAL-mode candidate would need, which is what makes an
 * unfinished artefact read as unverified and therefore KEPT.
 */
const openBackupCandidate = (file, key) => {
  if (key) {
    const encrypted = openEncrypted(file, key, { readonly: true });
    if (encrypted) {
      return encrypted;
    }
  }

  try {
    return new Database(file, { readonly: true });
  } catch (error) {
    return null;
  }
};

/**
 * Is this file a backup, or only a file with a backup's name?
 *
 * Retention used to answer that from the name alone, which is why an
 * interrupted run's partial file — right name, zero tables — could win a
 * `--keep 2` against two real backups and get both of them deleted. Note that
 * `integrity_check` on its own says "ok" about that partial: a hot journal
 * rolled it back to an empty but perfectly consistent database. The four tables
 * are the part that distinguishes a Lawha backup from a valid empty file.
 *
 * Opened READ-ONLY deliberately, for two reasons. A procedure that decides what
 * to delete must not be able to modify the evidence it decides on. And it fails
 * closed: a candidate still in WAL mode cannot be opened read-only without an
 * `-shm` that a read-only connection may not create, so it reads as unverified
 * and is KEPT — being wrong in the direction of keeping a file is the only
 * acceptable direction for this function to be wrong in.
 *
 * WITH A KEY it tries the key first and PLAIN SECOND, which is deliberately
 * more forgiving than `src/lib/backupVerify.ts` (strict, because it is judging
 * a copy this process has just written and must not accept plaintext where it
 * meant ciphertext). This one is judging an archive directory, and the day
 * `LAWHA_DB_KEY` is first set that directory holds weeks of PLAINTEXT backups
 * that are still perfectly good artefacts. Refusing to read them would not
 * lose anything — nothing here deletes what it cannot read — but it would
 * leave every one of them uncounted and unprunable, so the archive grows
 * forever and the disk fills, quietly, because every run still exits 0. That
 * is the failure `AGE_BACKUP_NAME` above already caused once.
 */
const isVerifiedBackup = (file, key) => {
  const db = openBackupCandidate(file, key);

  if (!db) {
    return false;
  }

  try {
    if (db.pragma("integrity_check")[0]?.integrity_check !== "ok") {
      return false;
    }
    return COUNTED_TABLES.every((table) => tableExists(db, table));
  } catch (error) {
    return false;
  } finally {
    db.close();
  }
};

/**
 * `age`'s own format signature: every file it writes, armored or not, opens
 * with this exact line ahead of the recipient stanzas — verified against the
 * real binary while writing this. It is the only thing retention CAN check
 * about an encrypted candidate: `integrity_check` and the four-table count
 * above both need the private key, and this process is built never to hold
 * one. A prefix match is still a real check, not a rubber stamp — it fails
 * closed on a zero-byte file, a stray file that only happens to match the
 * naming pattern, or a write that never got past opening its destination.
 * What it cannot catch is corruption inside a completely-written ciphertext,
 * because nothing short of the private key can look inside one; that gap is
 * inherent to Half A's design (the archive half must survive a fully
 * compromised server), not a shortcut taken here.
 */
const AGE_MAGIC = Buffer.from("age-encryption.org/v1");

const isVerifiedAgeArtifact = (file) => {
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
 * Encrypt `plaintext` to `recipient` by shelling out to `age -r <recipient>`.
 *
 * Deliberately a smaller copy of `encryptToRecipient` in
 * `src/lib/ageEncrypt.ts`, not an import of it — see the header comment for
 * why this script cannot depend on that module. The one rule it exists to
 * enforce is the same one that file states at length: every failure path
 * REJECTS. Nothing below may resolve with `plaintext`, or with anything that
 * is not genuinely `age`'s ciphertext — a verified backup piped through a
 * broken encryption step must fail loudly, never ship the plaintext under a
 * name that says it didn't.
 *
 * No internal kill-timer, unlike the library version: that timer exists there
 * to protect a long-running server process from a wedged `age` sitting on an
 * event loop nothing else can see. This script is a one-shot CLI invocation —
 * a wedged `age` here wedges the whole backup run visibly, the same way a
 * slow disk during `source.backup()` above does, and is somebody else's
 * timeout to enforce (`lawha-backup.sh`'s scheduler, or an operator's Ctrl-C)
 * rather than a second one duplicated in here.
 */
const encryptToRecipient = (plaintext, recipient) =>
  new Promise((resolve, reject) => {
    const child = spawn("age", ["-r", recipient], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    // `close` can fire after `error`, and stdin's own `error` can race the
    // child's `close` — one settle, first writer wins, same reasoning as the
    // library version.
    let settled = false;

    const failEncrypt = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`age encryption failed: ${message}`));
    };

    child.on("error", (error) => {
      // ENOENT (age not on PATH), EACCES, and friends — propagated, not
      // caught into a "friendlier" fallback, because that fallback is exactly
      // the shape of the bug this function must not have.
      failEncrypt(`could not start "age": ${error.message}`);
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    // Ignore-and-let-close-report: once `age` exits (a bad recipient refuses
    // to start) it closes stdin from its end, and Node raises EPIPE here on
    // the write that has not landed yet. The exit code and stderr the `close`
    // handler sees below is the true reason; without this handler the EPIPE
    // would surface as an unhandled `error` on the stream and crash the
    // process instead of rejecting cleanly.
    child.stdin.on("error", () => {});

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (signal) {
        failEncrypt(`killed by ${signal}`);
        return;
      }

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        failEncrypt(`exited ${String(code)}${stderr ? ` — ${stderr}` : ""}`);
        return;
      }

      const ciphertext = Buffer.concat(stdoutChunks);

      // Belt-and-braces against the exact failure this function must not
      // have: `age` exiting 0 with nothing on stdout would look, to a naive
      // caller, like a successful encryption of nothing.
      if (ciphertext.length === 0 && plaintext.length > 0) {
        failEncrypt("exited 0 but produced no output");
        return;
      }

      settled = true;
      resolve(ciphertext);
    });

    child.stdin.end(plaintext);
  });

/**
 * Replace the plaintext file at `plainPath` with its encrypted form, in
 * place, and only ever under a finished name.
 *
 * Shared by both callers that need it — the verified artefact and a
 * `.rejected` quarantine copy — because "encrypt a file and swap it for the
 * plaintext" is exactly one operation with exactly one safety rule, and
 * writing it twice is how the two copies drift. `cipherPartialPath` is
 * written first and renamed onto `cipherPath` only once complete, the same
 * `.partial`-then-rename pattern used everywhere else in this file, so a
 * failure or interruption partway through never leaves anything wearing a
 * finished name. `plainPath` is deleted only on success — the caller decides
 * what "encryption failed" means for the file it was protecting; this
 * function's job is only to never lose track of which copy is authoritative
 * while it does not know yet.
 */
const encryptInPlace = async (
  plainPath,
  cipherPartialPath,
  cipherPath,
  recipient,
) => {
  const ciphertext = await encryptToRecipient(
    fs.readFileSync(plainPath),
    recipient,
  );
  fs.writeFileSync(cipherPartialPath, ciphertext);
  fs.renameSync(cipherPartialPath, cipherPath);
  removeWithSidecars(plainPath);
};

// `--keep=7` and `--keep 7` are both things people type, and getting the
// second silently ignored would mean a retention policy that never ran.
const args = process.argv.slice(2).flatMap((arg) => {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
});

let destDir = null;
let keep = null;
let dbPath = process.env.LAWHA_DB_PATH || DEFAULT_DB_PATH;

/**
 * Mirrors `backupRecipient` in `src/config.ts` — `|| null`, not `?? null`,
 * so an explicit `LAWHA_BACKUP_RECIPIENT=` (blank) disables encryption the
 * same way leaving it unset does. Read directly from the environment rather
 * than through `loadConfig()`, for the same reason `DEFAULT_DB_PATH` above is
 * duplicated: this script runs under plain `node`, never through the TS
 * config loader, and `lawha-backup.sh` invokes it exactly that way. Not
 * re-validated against `AGE_RECIPIENT_PATTERN` here — a malformed value is
 * already refused at server boot by `config.ts`, and `age` itself refuses a
 * malformed recipient with a clear message (verified against the real
 * binary), so a second, drifted copy of that regex would buy nothing this
 * script's own failure path does not already cover.
 */
const recipient = process.env.LAWHA_BACKUP_RECIPIENT || null;

/**
 * `LAWHA_DB_KEY` — the SQLCipher key the LIVE database is under, mirroring
 * `dbKey` in `src/config.ts` down to the `|| null`, so an explicit blank
 * disables it exactly as leaving it unset does. Read straight from the
 * environment for the same reason `recipient` above is, and carried VERBATIM:
 * a key this script trimmed or normalised on the way past would open nothing,
 * and the operator's only evidence would be a value in `lawha.env` that looks
 * right.
 *
 * Note where the key actually is on backup day. `lawha.env` reaches the
 * CONTAINERS, so the scheduled backup in `lawha-backup` has it; a backup run
 * BY HAND on the host does not, unless the operator exports it. That makes
 * "the database is encrypted and no key was given" the most reachable mistake
 * here, and it is answered by name below rather than as "file is not a
 * database".
 */
const dbKey = process.env.LAWHA_DB_KEY || null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--keep") {
    i += 1;
    keep = Number(args[i]);
    if (!Number.isInteger(keep) || keep < 1) {
      // Refused rather than clamped: `--keep 0` would delete the backup this
      // very run just took, which is the one outcome nobody types it for.
      fail("--keep needs a whole number of backups to keep, at least 1");
    }
  } else if (arg === "--db") {
    i += 1;
    dbPath = args[i];
    if (!dbPath) {
      fail("--db needs a path");
    }
  } else if (arg.startsWith("-")) {
    process.stderr.write(USAGE);
    fail(`unknown option "${arg}"`);
  } else if (destDir === null) {
    destDir = arg;
  } else {
    process.stderr.write(USAGE);
    fail(`unexpected argument "${arg}"`);
  }
}

if (!destDir) {
  process.stderr.write(USAGE);
  fail("no destination directory given");
}

/**
 * Checked after the argument loop, not before it, so `--help` still answers a
 * question that has nothing to do with the key — and before anything is read,
 * copied or created, because a key the server would refuse is a configuration
 * mistake and not a backup that half-happened.
 */
if (dbKey !== null && dbKey.length < MIN_DB_KEY_LENGTH) {
  fail(
    `LAWHA_DB_KEY is ${dbKey.length} characters and the server refuses to ` +
      `boot with anything under ${MIN_DB_KEY_LENGTH} (src/config.ts). ` +
      "Backing up with it would produce an archive only a server that will " +
      "not start could open. Nothing has been written.",
  );
}

/**
 * THIS SCRIPT MUST LOAD AND RUN WITH THE CIPHER DRIVER ABSENT. That is not a
 * nicety; a top-level `import` of it here broke the live deployment's backup
 * schedule the instant the line was written, and nothing in the repository
 * would have shown it.
 *
 * `docker-compose.yml` mounts `./lawha-server/scripts:/opt/lawha/scripts:ro`.
 * These scripts are the ONLY part of the stack served from the working tree
 * rather than baked into an image, so an edit here is live in the running
 * `lawha-backup` container immediately — against whatever `node_modules` that
 * container's image was built with, which may be months old. Measured, in the
 * running container:
 *
 *   $ docker exec lawha-backup ls /opt/lawha/node_modules | grep sqlite
 *   better-sqlite3
 *   $ docker exec lawha-backup node /opt/lawha/scripts/backup.mjs …
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *     'better-sqlite3-multiple-ciphers' imported from …/backup.mjs
 *
 * An ESM top-level import is resolved before the first line of the module
 * body runs, so that failure precedes argument parsing, the `--help` text and
 * every refusal in this file. A deployment that never set `LAWHA_DB_KEY` — and
 * therefore opted into nothing — silently lost both its six-hourly backup and,
 * because `restore.mjs` had the same line, its recovery path, at the same
 * moment.
 *
 * A dynamic import inside this branch decouples the script from the image
 * entirely. It is the same rule `src/lib/backupSnapshot.ts` states for the
 * event loop — "a deployment that never set LAWHA_DB_KEY should not pay for a
 * feature it did not enable" — applied to the dependency itself, which is the
 * more expensive half.
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
        "lawha: Nothing has been written and nothing has been changed.",
    );
  }
};

if (dbKey !== null) {
  await loadCipherDriver();
}

dbPath = path.resolve(dbPath);
destDir = path.resolve(destDir);

if (!fs.existsSync(dbPath)) {
  fail(
    `no database at ${dbPath} — set LAWHA_DB_PATH or pass --db (under Docker the host path is the bind mount, not /data)`,
  );
}

fs.mkdirSync(destDir, { recursive: true });

const destination = path.join(destDir, `lawha-${stamp(new Date())}.db`);

/**
 * The copy is written here and only renamed onto `destination` once every check
 * below has passed. `.partial` is outside the `lawha-*.db` namespace
 * `BACKUP_NAME` matches, so however this run ends — verified, rejected,
 * interrupted, killed outright — nothing that is not a finished backup ever
 * carries a backup's name, and neither retention nor `restore.mjs` can be
 * fooled by one. The rename is atomic within a filesystem, so a concurrent
 * reader sees either no such name or a fully verified file.
 */
const partial = `${destination}.partial`;

/**
 * The encrypted artefact's final name and its own `.partial` staging name,
 * same reasoning as `destination`/`partial` above: `cipherPartial` is written
 * in full before it is ever renamed onto `cipherPath`, so nothing wearing the
 * `.age` name is ever anything but a complete ciphertext. Computed
 * unconditionally — cheap, and it means the interrupt handler below can
 * always reference `cipherPartial` without branching on whether a recipient
 * is configured this run.
 */
const cipherPath = `${destination}.age`;
const cipherPartial = `${cipherPath}.partial`;

/**
 * The quarantine copy's own final and staging names — `reject()`, below,
 * produces one of these instead of a real artefact. Computed unconditionally
 * and up here for the same reason `cipherPath`/`cipherPartial` are: the
 * interrupt handler needs to recognise them whether or not this run ever
 * calls `reject()` at all, and it is registered before `reject` is even
 * defined.
 */
const rejectedPlain = `${destination}.rejected`;
const rejectedCipherPartial = `${rejectedPlain}.age.partial`;
const rejectedCipher = `${rejectedPlain}.age`;

if (fs.existsSync(destination)) {
  fail(`${destination} already exists; wait a second and run it again`);
}

if (fs.existsSync(partial)) {
  fail(`${partial} already exists; wait a second and run it again`);
}

if (recipient && fs.existsSync(cipherPath)) {
  fail(`${cipherPath} already exists; wait a second and run it again`);
}

if (recipient && fs.existsSync(cipherPartial)) {
  fail(`${cipherPartial} already exists; wait a second and run it again`);
}

/**
 * `db.backup()` copies 100 pages per tick and, on failure, calls `close()` and
 * nothing else — it does not unlink what it has written. Without this the
 * remains of an interrupted backup stayed on disk, and staying on disk under
 * the FINAL name is what let retention mistake them for a backup.
 *
 * These three are the signals a Ctrl-C, a `docker stop` and a closed terminal
 * actually send. SIGKILL and a power cut cannot be handled by anybody, which is
 * the other half of why the file does not wear its final name until it is done.
 */
const INTERRUPTS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
/**
 * Whatever plaintext currently exists and would need deleting if this
 * process is interrupted right now — `partial` during the SQLite copy and
 * its verification, `rejectedPlain` for the entire time `reject()` spends
 * producing a quarantine copy (including the `await` while `age` runs, when
 * a recipient is configured), and `null` only once nothing plaintext
 * remains: either a finished artefact has replaced it, or `reject()`'s own
 * cleanup has already run.
 *
 * An earlier version of `reject()` set this to `null` immediately after
 * renaming `partial` to `rejectedPlain` — before encrypting it, not after.
 * For the whole `await encryptInPlace(...)` window that followed, `unfinished`
 * was `null` and `finished` was still `null` too, so an interrupt fell into
 * the "nothing was removed" branch below while a complete, readable copy of
 * the database — `SQLite format 3` header intact — sat at `rejectedPlain` on
 * disk. Reproduced: a wrapper `age` that sleeps, SIGTERM mid-sleep, exit 143,
 * stderr claiming nothing was removed, `lawha-<stamp>.db.rejected` left
 * behind, readable, in the one deployment mode whose entire point is that
 * plaintext must never be left there. Compare the main artefact path further
 * below, which was always correct: `unfinished` stays `= partial` across its
 * own equivalent `await encryptInPlace(...)`, cleared only once encryption
 * has actually finished or failed. `reject()` now does the same.
 *
 * `finished` is set only once the FINAL rename has happened, so the three
 * cases below can be told apart in the message rather than guessed at.
 */
let unfinished = partial;
let finished = null;

for (const [signal, number] of Object.entries(INTERRUPTS)) {
  process.on(signal, () => {
    if (unfinished) {
      removeWithSidecars(unfinished);
      // Both partial-cipher names, unconditionally: whichever one does not
      // apply to the stage this run is actually in is simply absent, and
      // `removeWithSidecars` is a no-op against a path that does not exist.
      // Cheaper than branching on which of the two `await encryptInPlace`
      // call sites is in flight, and it cannot be wrong the way that
      // branching could be if a third call site is ever added and forgotten.
      removeWithSidecars(cipherPartial);
      removeWithSidecars(rejectedCipherPartial);
      // The two plaintext names read differently to a human — "no backup was
      // written" is true of both, but only one of them was ever going to
      // become a backup at all, and saying so is more honest than reusing
      // one generic sentence for a database copy and a rejected quarantine
      // copy alike.
      process.stderr.write(
        unfinished === rejectedPlain
          ? `lawha: interrupted by ${signal} — the rejected copy awaiting encryption was removed; no backup was written\n`
          : `lawha: interrupted by ${signal} — the partial copy was removed; no backup was written\n`,
      );
    } else if (finished) {
      // Saying "no backup was written" here would send somebody looking for a
      // file that is on disk, verified, a few lines above.
      process.stderr.write(
        `lawha: interrupted by ${signal} after ${finished} was written and verified; retention may not have run\n`,
      );
    } else {
      process.stderr.write(
        `lawha: interrupted by ${signal}; nothing was removed — see ${destDir}\n`,
      );
    }
    // 128+n is what a shell reports for a signalled process, and exit status is
    // the entire interface this script has with a cron or systemd wrapper.
    process.exit(128 + number);
  });
}

/**
 * Opened read-write, deliberately, even though a backup reads nothing but
 * pages. A read-only connection cannot create the `-shm` file a WAL database
 * needs, so after a clean server shutdown — when SQLite has removed `-wal` and
 * `-shm` — `readonly: true` fails outright with "unable to open database
 * file". Read-write opens in both states, and neither the online backup API
 * nor `VACUUM INTO` writes anything to the source.
 */
let source;

if (dbKey === null) {
  if (!readsAsPlaintextSqlite(dbPath)) {
    // Said by name rather than reached as "backup failed: file is not a
    // database" three lines further down. A backup run by hand on the host
    // has no LAWHA_DB_KEY unless the operator exported one, and a scheduled
    // run against a database somebody encrypted without updating lawha.env
    // looks identical from here. Both readings are given, in the same order
    // and for the same reason `describeFailure` in src/db/index.ts gives
    // them: from outside, an encrypted file and a damaged one are the same
    // bytes.
    fail(
      fs.statSync(dbPath).size === 0
        ? // Its own sentence, because "encrypted or damaged" would be
          // actively misleading here: an empty file has no magic to match, so
          // it lands in this branch while being neither.
          `${dbPath} is an empty file — there is nothing to back up. Check ` +
            "LAWHA_DB_PATH (under Docker the host path is the bind mount, " +
            "not /data). Nothing has been written."
        : `${dbPath} is not a plain SQLite database and LAWHA_DB_KEY is not ` +
            "set. Either it is ENCRYPTED and this needs the same " +
            "LAWHA_DB_KEY the server boots with (it is in lawha.env, which " +
            "only reaches the containers — export it for a run by hand), or " +
            "it is DAMAGED. Nothing has been written and nothing has been " +
            "changed.",
    );
  }

  source = new Database(dbPath);
} else {
  source = openEncrypted(dbPath, dbKey);

  if (!source) {
    fail(
      `LAWHA_DB_KEY does not open ${dbPath}. ${
        readsAsPlaintextSqlite(dbPath)
          ? "That file is a PLAIN SQLite database — nothing is wrong with it " +
            "and nothing here has changed it; unset LAWHA_DB_KEY to back it " +
            "up, or encrypt it first with `yarn --cwd lawha-server " +
            "encrypt-db`."
          : "To SQLite a wrong key and a damaged file look identical, so " +
            "check LAWHA_DB_KEY against the key this database was encrypted " +
            "with before assuming the worse of the two."
      } Nothing has been written.`,
    );
  }
}

try {
  if (dbKey === null) {
    await source.backup(partial);
  } else {
    // See the header comment: the online backup API refuses an encrypted
    // source paired with the plain destination it creates for itself, and
    // `VACUUM INTO` is what carries the cipher and the key across. The
    // destination is a bound parameter rather than an interpolated path.
    //
    // This branch is one synchronous statement where the other yields every
    // 100 pages, so a signal arriving during it is queued rather than landing
    // mid-copy. That is a smaller window, not a larger one — and `partial` is
    // outside the `lawha-*.db` namespace either way, so nothing wearing a
    // finished backup's name can result from an interrupted copy.
    source.prepare("VACUUM INTO ?").run(partial);
  }
} catch (error) {
  source.close();
  removeWithSidecars(partial);
  fail(`backup failed: ${error.message}`);
}

source.close();

/**
 * `journal_mode = DELETE` on the copy is what makes the artefact a single
 * file. `db.backup()` reproduces the source's header, WAL flag and all, so
 * opening the copy would otherwise leave a `-wal` and a `-shm` beside it — the
 * exact sidecars this whole script exists to avoid having to restore
 * alongside. The server sets `journal_mode = WAL` again when it opens the
 * restored file (`src/db/index.ts`), so nothing is lost by storing it this
 * way.
 *
 * On the keyed branch this is opened WITH THE KEY, and that is the whole of
 * the verification being real: `integrity_check` and the four counts below all
 * read through this connection, so an artefact nothing can open is an artefact
 * this script refuses rather than ships. (`VACUUM INTO` already produces a
 * `journal_mode = delete` file, so the pragma is a no-op on that branch — kept
 * rather than branched around, because "the artefact is single-file" should be
 * asserted the same way on both paths.)
 */
const copy =
  dbKey === null ? new Database(partial) : openEncrypted(partial, dbKey);

if (!copy) {
  // Reachable only if the copy just written cannot be opened with the key it
  // was written under — the artefact is not a backup, and it must not be left
  // wearing a name anything would restore from.
  removeWithSidecars(partial);
  fail(
    `the copy at ${partial} does not open with LAWHA_DB_KEY, even though ` +
      "making it reported success. Nothing has been written to the archive.",
  );
}

/**
 * A rejected copy is kept for inspection, not deleted — unlike a `.partial`,
 * which is not a database at all, this one is a COMPLETE copy that failed
 * verification, and someone will want to know why. It is renamed out of the
 * `lawha-*.db`/`lawha-*.db.age` namespace either way, so retention and
 * restore both ignore it: a corrupt file that still looks like a backup is
 * worse than no file at all.
 *
 * When a recipient is configured, that copy is still a database's worth of
 * real data — board content if verification failed on a technicality, or an
 * entirely different database's contents if `--db` pointed at the wrong
 * file entirely — and "it failed verification" is not "safe to leave in the
 * clear". A backup archive an operator chose to encrypt does not get a
 * plaintext exception carved out of it for the one artefact most likely to
 * need a second look. Encrypted here with the same `encryptInPlace` the
 * verified path uses, so inspecting it needs the private key exactly like
 * inspecting a real backup does — the operator who wants to look already
 * holds that key.
 *
 * `unfinished` is updated to `rejectedPlain` here, NEVER cleared to `null`
 * until this function reaches one of its own terminal states (no recipient
 * configured and about to fail; encryption finished and the plaintext is
 * gone; encryption failed and cleanup already ran). See the long comment on
 * `unfinished`'s declaration above for the incident this replaced — clearing
 * it early here was a real, reproduced Critical regression: a signal landing
 * during `await encryptInPlace` below found the interrupt handler unaware
 * that `rejectedPlain` — a complete, readable copy of the database — was
 * sitting on disk.
 */
const reject = async (reason) => {
  copy.close();
  fs.renameSync(partial, rejectedPlain);
  unfinished = rejectedPlain;

  if (!recipient) {
    unfinished = null;
    fail(
      `${reason}\nlawha: kept for inspection at ${rejectedPlain} — DO NOT RESTORE IT`,
    );
    return;
  }

  try {
    await encryptInPlace(
      rejectedPlain,
      rejectedCipherPartial,
      rejectedCipher,
      recipient,
    );
    // The plaintext is gone — `encryptInPlace` deleted it on success — and
    // the ciphertext now at `rejectedCipher` is not a secret worth an
    // interrupt handler's protection; encrypting it was the whole point.
    unfinished = null;
    fail(
      `${reason}\nlawha: kept for inspection, encrypted, at ${rejectedCipher} ` +
        "— decrypt it with the private key before inspecting; DO NOT RESTORE IT",
    );
  } catch (error) {
    // Encrypting the quarantine copy failed too. The one thing worse than no
    // rejected copy is a plaintext one sitting in an archive that was
    // supposed to hold none — so this cleans up rather than falling back to
    // the plaintext version, and says so.
    removeWithSidecars(rejectedPlain);
    removeWithSidecars(rejectedCipherPartial);
    unfinished = null;
    fail(
      `${reason}\nlawha: additionally, the rejected copy could not be ` +
        `encrypted (${error.message}) — nothing was kept for inspection, ` +
        "because a recipient is configured and plaintext must not be left " +
        "in the archive",
    );
  }
};

copy.pragma("journal_mode = DELETE");

const integrity = copy.pragma("integrity_check")[0]?.integrity_check;

if (integrity !== "ok") {
  // Awaited: `reject` is async now that it may itself encrypt, and letting
  // it run in the background would fall through to the `missing`-tables
  // check below while a rename/encrypt it started is still in flight —
  // exactly the kind of race this file's own header warns about elsewhere.
  await reject(`integrity_check on the backup said "${integrity}", not "ok"`);
}

const missing = COUNTED_TABLES.filter((table) => !tableExists(copy, table));

if (missing.length > 0) {
  await reject(
    `the backup has no ${missing.join(
      ", ",
    )} table — ${dbPath} is not a Lawha database`,
  );
}

const counts = COUNTED_TABLES.map((table) => [
  table,
  copy.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
]);

copy.close();

// Everything above passed, so `partial` is now a verified plaintext backup —
// PLAINTEXT is the operative word: everything that follows either gives it a
// backup's name directly, or encrypts it first and gives the CIPHERTEXT that
// name instead. Until this line neither could have been mistaken for one.
let artifact;

if (recipient) {
  try {
    // Written under `.partial` first so nothing wearing `cipherPath` is ever
    // anything but a complete ciphertext, then renamed into the namespace
    // `retention` recognises — see `encryptInPlace`. It also deletes
    // `partial` on success: the plaintext temporary copy has done its job
    // once it has been read, and keeping it around would be exactly the leak
    // encryption exists to prevent.
    await encryptInPlace(partial, cipherPartial, cipherPath, recipient);
  } catch (error) {
    // A recipient is configured, so plaintext must never be left in the
    // archive — not even under `.partial`, which retention already ignores
    // but a human `ls` would not. The verified copy this run produced is
    // gone; the run reports failure and writes nothing, same as a source
    // that fails `integrity_check` reports failure rather than half-succeeding.
    removeWithSidecars(partial);
    removeWithSidecars(cipherPartial);
    unfinished = null;
    fail(`could not encrypt the verified backup: ${error.message}`);
  }

  artifact = cipherPath;
} else {
  fs.renameSync(partial, destination);
  artifact = destination;
}

unfinished = null;
finished = artifact;

const bytes = fs.statSync(artifact).size;

say(`lawha: backed up ${dbPath}`);
say(
  `lawha:        to ${artifact} (${bytes} bytes, integrity_check ok${
    // Two independent facts about one file, so they are said separately
    // rather than folded into one word: "SQLCipher" means LAWHA_DB_KEY is
    // needed to open it, "encrypted" means the age private key is. A restore
    // may need either, both, or neither, and the operator reading this line
    // is the person who will have to find out.
    dbKey === null ? "" : ", SQLCipher"
  }${recipient ? ", encrypted" : ""})`,
);
for (const [table, n] of counts) {
  say(`lawha:   ${String(n).padStart(6)}  ${table}`);
}

const users = counts.find(([table]) => table === "users")?.[1] ?? 0;

if (users === 0) {
  // Not a failure — a server nobody has signed up to yet is genuinely empty —
  // but zero accounts is also exactly what a `cp` of the 4KB header produces,
  // so it never passes without being said out loud.
  process.stderr.write(
    "lawha: WARNING — this backup contains no user accounts. That is correct only if nobody has ever registered.\n",
  );
}

if (keep !== null) {
  // Both namespaces, sorted TOGETHER rather than pruned separately — a
  // separate `--keep N` per form would mean N plaintext runs ago plus N
  // encrypted runs ago, twice the artefacts anyone asked to keep. Sorting
  // the combined list works because the timestamp prefix both patterns share
  // is fixed-width and always compared before the diverging `.db`/`.db.age`
  // suffix, so two DIFFERENT stamps sort chronologically regardless of which
  // form either one is.
  const existing = fs
    .readdirSync(destDir)
    .filter((name) => BACKUP_NAME.test(name) || AGE_BACKUP_NAME.test(name))
    .sort();

  /**
   * `--keep N` means N backups, not N filenames. Counting names was how a
   * partial file left by an interrupted run — same shape of name, sorting
   * newest, zero tables inside — got itself kept while both real backups either
   * side of it were deleted to make room. A file this loop cannot read is
   * neither counted nor removed: it is reported and left exactly where it is,
   * because the one thing worse than an unreadable file in the archive is one
   * fewer readable file in the archive.
   *
   * "Read" means something narrower for a `.age` candidate than for a `.db`
   * one — `isVerifiedAgeArtifact` above is the ceiling of what is checkable
   * without the private key this process never holds — but the rule those
   * comments describe is unchanged: unreadable is reported and left alone,
   * never counted, never deleted.
   */
  const verified = existing.filter((name) => {
    const file = path.join(destDir, name);
    const ok = AGE_BACKUP_NAME.test(name)
      ? isVerifiedAgeArtifact(file)
      : isVerifiedBackup(file, dbKey);

    if (ok) {
      return true;
    }
    process.stderr.write(
      `lawha: WARNING — ${file} does not open as a Lawha backup. Retention has NOT counted it and has NOT deleted it; check it by hand.\n`,
    );
    return false;
  });

  for (const name of verified.slice(0, Math.max(0, verified.length - keep))) {
    for (const suffix of SIDECARS) {
      // The sidecars should not exist — see journal_mode above — but an older
      // backup taken before this script did, or one somebody opened with a
      // sqlite client, will have them, and leaving a stray `-wal` beside a
      // deleted `.db` is how a future restore picks up somebody else's pages.
      const stale = path.join(destDir, `${name}${suffix}`);
      if (fs.existsSync(stale)) {
        fs.unlinkSync(stale);
      }
    }
    say(`lawha: retention removed ${path.join(destDir, name)}`);
  }
}

say(
  `lawha: NOTE — uploaded blobs are not in this file. Copy them separately: cp -a ${
    process.env.LAWHA_FILES_DIR || path.join(path.dirname(dbPath), "files")
  } ${destDir}/`,
);
