/**
 * Shared setup for the `node:test` suites beside `backup.mjs` and
 * `restore.mjs`.
 *
 * They live in `scripts/` rather than in `tests/` on purpose: vitest's include
 * is `tests/ ** / *.test.ts`, TypeScript only, and these scripts are plain
 * `.mjs` run by `node` with no build step. Running them with `node --test
 * scripts/` exercises byte-for-byte the artefact an operator invokes, rather
 * than a compiled stand-in. `yarn --cwd lawha-server test` runs both suites.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import CipherDatabase from "better-sqlite3-multiple-ciphers";

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const makeTempDir = (prefix) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `lawha-${prefix}-`));

/**
 * The first sixteen bytes of every unencrypted SQLite file — the same constant,
 * for the same reason, as `SQLITE_MAGIC` in `src/db/index.ts`. SQLCipher
 * encrypts the header along with everything else, so this is what tells the two
 * apart from outside, with no key and without opening anything.
 *
 * The NUL is written `\0` rather than pasted in literally: a raw NUL in the
 * source makes git call the file binary and stops the diff being reviewable.
 */
export const SQLITE_MAGIC = "SQLite format 3\0";

export const firstBytes = (file, length = SQLITE_MAGIC.length) => {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString("latin1");
  } finally {
    fs.closeSync(handle);
  }
};

/**
 * The assertion the whole keyed half of these suites rests on, and the reason
 * it reads BYTES rather than a filename: a file called `lawha-<stamp>.db` that
 * begins `SQLite format 3` when the run said it wrote ciphertext is the
 * failure, and no assertion about a name can see it.
 */
export const readsAsPlaintextSqlite = (file) => firstBytes(file) === SQLITE_MAGIC;

/**
 * `key='…'` with the passphrase escaped as a SQL string literal — the same
 * function as `keyPragma` in `src/db/index.ts`, so a fixture built here is
 * keyed exactly the way the server keys the live database.
 */
const keyLiteral = (key) => `'${key.replace(/'/g, "''")}'`;

/**
 * Open `file` the way `src/db/index.ts` opens the live database: `cipher`
 * BEFORE `key` (the driver's default is chacha20, not sqlcipher, so the order
 * decides the on-disk format), then a real read — `PRAGMA key` answers `ok`
 * for any key at all, because SQLCipher has not touched a page yet.
 */
export const openEncrypted = (file, key, options = {}) => {
  const db = new CipherDatabase(file, options);
  db.pragma("cipher=sqlcipher");
  db.pragma(`key=${keyLiteral(key)}`);
  db.prepare("SELECT count(*) FROM sqlite_master").get();
  return db;
};

const LAWHA_SCHEMA =
  "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);" +
  "CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL);" +
  "CREATE TABLE board_scenes (board_id TEXT PRIMARY KEY, rev INTEGER NOT NULL);" +
  "CREATE TABLE files (id TEXT PRIMARY KEY, blob BLOB);";

/**
 * A database in the state the live one is actually in: WAL mode, with every
 * table sitting in `lawha.db-wal` because the connection is still open and
 * nothing has checkpointed. That is the whole point of these tests — a backup
 * taken against this must contain the rows, and `cp lawha.db` must not.
 *
 * The caller owns the returned connection and must close it, exactly as a
 * running server would hold it open.
 */
export const createLiveDatabase = (
  dir,
  { users = 0, boards = 0, scenes = 0, files = 0, pageSize = null } = {},
) => {
  const dbPath = path.join(dir, "lawha.db");
  const db = new Database(dbPath);

  // Before `journal_mode`, and only when asked: SQLite refuses to change the
  // page size of a WAL database, so this is the one moment it can be set. It
  // exists for `encrypt-db.test.mjs`, which needs a 512-byte-page source to
  // pin the one page size SQLCipher cannot rekey in place.
  if (pageSize !== null) {
    db.pragma(`page_size = ${pageSize}`);
  }

  db.pragma("journal_mode = WAL");
  db.exec(LAWHA_SCHEMA);

  const insert = (sql, count) => {
    const statement = db.prepare(sql);
    for (let i = 0; i < count; i += 1) {
      statement.run(`${i}`);
    }
  };

  insert("INSERT INTO users (id, username) VALUES (?, 'someone')", users);
  insert("INSERT INTO boards (id, name) VALUES (?, 'a board')", boards);
  insert("INSERT INTO board_scenes (board_id, rev) VALUES (?, 1)", scenes);
  insert("INSERT INTO files (id) VALUES (?)", files);

  return { dbPath, db };
};

/**
 * The same live database, keyed with SQLCipher the way `LAWHA_DB_KEY` keys the
 * real one — WAL, still open, every row sitting in `lawha.db-wal` because
 * nothing has checkpointed.
 *
 * That last part is the whole point of using it rather than a checkpointed
 * fixture: an artefact taken from this must contain the rows, which is what
 * distinguishes a real copy from a `cp` of the 4KB header, and it has to keep
 * being true now that the copy goes through a different mechanism.
 *
 * The caller owns the returned connection and must close it, exactly as a
 * running server would hold it open.
 */
export const createEncryptedLiveDatabase = (
  dir,
  key,
  { users = 0, boards = 0, scenes = 0, files = 0 } = {},
) => {
  const dbPath = path.join(dir, "lawha.db");
  const db = new CipherDatabase(dbPath);

  // `cipher` before `key`, for the reason `src/db/index.ts` states in capital
  // letters: the key is interpreted by whichever scheme is selected at the
  // moment it is set, and this driver's default is chacha20.
  db.pragma("cipher=sqlcipher");
  db.pragma(`key=${keyLiteral(key)}`);
  db.pragma("journal_mode = WAL");
  db.exec(LAWHA_SCHEMA);

  const insert = (sql, count) => {
    const statement = db.prepare(sql);
    for (let i = 0; i < count; i += 1) {
      statement.run(`${i}`);
    }
  };

  insert("INSERT INTO users (id, username) VALUES (?, 'someone')", users);
  insert("INSERT INTO boards (id, name) VALUES (?, 'a board')", boards);
  insert("INSERT INTO board_scenes (board_id, rev) VALUES (?, 1)", scenes);
  insert("INSERT INTO files (id) VALUES (?)", files);

  return { dbPath, db };
};

/**
 * A database left exactly as a server that was killed leaves one: every table
 * in `lawha.db-wal`, a bare 4KB header in `lawha.db`, an `-shm` beside them —
 * and NO process holding any of it open.
 *
 * That last part is why this exists rather than the caller simply keeping the
 * connection from `createLiveDatabase`. An open connection is a running server,
 * and `restore.mjs` now refuses to run under one; the state that actually needs
 * checkpointing before the move-aside is this one, which is the state the live
 * rehearsal produced (`docs/lawha-roadmap.md` §4.13: rows inserted and the
 * process killed without closing, so they existed only in the `-wal`).
 *
 * Built in a child process because it cannot be built in this one: closing a
 * WAL connection cleanly checkpoints it and removes the sidecar, which is the
 * opposite of what is wanted. The module path is resolved here and passed
 * through, so the child does not depend on its own working directory.
 */
export const createAbandonedDatabase = (dir, { users = 0, boards = 0 } = {}) => {
  const dbPath = path.join(dir, "lawha.db");
  const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const Database = require(${JSON.stringify(modulePath)});
       const db = new Database(${JSON.stringify(dbPath)});
       db.pragma("journal_mode = WAL");
       db.exec(${JSON.stringify(LAWHA_SCHEMA)});
       const addUser = db.prepare("INSERT INTO users (id, username) VALUES (?, 'someone')");
       for (let i = 0; i < ${users}; i += 1) { addUser.run(String(i)); }
       const addBoard = db.prepare("INSERT INTO boards (id, name) VALUES (?, 'a board')");
       for (let i = 0; i < ${boards}; i += 1) { addBoard.run(String(i)); }
       process.kill(process.pid, "SIGKILL");`,
    ],
    { encoding: "utf8" },
  );

  if (child.signal !== "SIGKILL") {
    throw new Error(
      `the stand-in server exited instead of being killed: ${child.status} ${child.stderr}`,
    );
  }

  return dbPath;
};

/**
 * A finished, verifiable backup artefact placed in an archive directory under a
 * name of this operator's choosing — a stand-in for "a real backup taken last
 * Tuesday".
 *
 * It has to be a genuine database rather than a zero-byte placeholder now that
 * retention opens every candidate before counting it: a placeholder is exactly
 * the artefact an interrupted backup used to leave, and retention is required
 * to treat those as unreadable. Single-file (`journal_mode = DELETE`) for the
 * same reason `backup.mjs` writes them that way.
 */
export const stageVerifiedBackup = (dir, name, { users = 1 } = {}) => {
  const file = path.join(dir, name);
  const db = new Database(file);

  db.pragma("journal_mode = DELETE");
  db.exec(LAWHA_SCHEMA);

  const insert = db.prepare("INSERT INTO users (id, username) VALUES (?, 'someone')");
  for (let i = 0; i < users; i += 1) {
    insert.run(`${i}`);
  }

  db.close();
  return file;
};

/**
 * A source database with a great many small pages.
 *
 * `db.backup()` copies 100 pages per event-loop tick, so how long a backup
 * takes is governed by the PAGE count, not the byte count: `page_size = 512`
 * buys a copy that lasts hundreds of milliseconds for a file small enough to
 * build in a test. That window is what makes interrupting one reliable rather
 * than a race — the interrupt fires as soon as the destination appears, tens of
 * milliseconds into a window two orders of magnitude longer.
 */
export const createBulkyDatabase = (
  dir,
  { rows = 8000, users = 1, pageSize = 512 } = {},
) => {
  const dbPath = path.join(dir, "lawha.db");
  const db = new Database(dbPath);

  // 512 by default, for the reason above. `encrypt-db.test.mjs` overrides it:
  // SQLCipher cannot rekey a 512-byte-page database in place at all (it
  // reports success and produces a file no key opens), so an interrupt test
  // built on this fixture would be measuring the wrong refusal.
  db.pragma(`page_size = ${pageSize}`);
  db.exec(LAWHA_SCHEMA);

  const addUser = db.prepare("INSERT INTO users (id, username) VALUES (?, 'someone')");
  for (let i = 0; i < users; i += 1) {
    addUser.run(`${i}`);
  }

  const addFile = db.prepare("INSERT INTO files (id, blob) VALUES (?, ?)");
  const blob = Buffer.alloc(2048, 7);
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      addFile.run(`${i}`, blob);
    }
  })();

  db.close();
  return dbPath;
};

/**
 * A big keyed source, so the copy of it lasts long enough to be caught in the
 * act.
 *
 * `createBulkyDatabase` reaches its size with `page_size = 512`, because
 * `db.backup()`'s cost is per PAGE. That trick is unavailable here twice over:
 * SQLCipher reserves part of every page for its IV and HMAC and does not work
 * at 512 (`encrypt-db.mjs` refuses that page size by name), and the keyed copy
 * goes through `VACUUM INTO`, whose cost is per BYTE. So this gets its window
 * from bulk instead — 24 MB of blob, which takes long enough to write out that
 * a 1ms poll reliably catches the destination mid-copy.
 *
 * Closed before it is returned, unlike `createEncryptedLiveDatabase`: the test
 * this exists for kills the backup process, and a stray open handle in the
 * TEST process would only muddy what is being observed on disk.
 */
export const createBulkyEncryptedDatabase = (dir, key, { rows = 12000 } = {}) => {
  const dbPath = path.join(dir, "lawha.db");
  const db = new CipherDatabase(dbPath);

  db.pragma("cipher=sqlcipher");
  db.pragma(`key=${keyLiteral(key)}`);
  db.exec(LAWHA_SCHEMA);
  db.prepare("INSERT INTO users (id, username) VALUES ('0', 'someone')").run();

  const addFile = db.prepare("INSERT INTO files (id, blob) VALUES (?, ?)");
  const blob = Buffer.alloc(2048, 7);
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      addFile.run(`${i}`, blob);
    }
  })();

  db.close();
  return dbPath;
};

/**
 * Run a script and send it `signal` the moment it creates its first file in
 * `watchDir` — an operator's Ctrl-C landing part-way through, which is the
 * cheapest interruption to reach and the one that left an 11MB partial file
 * wearing a finished backup's name.
 *
 * Polling at 1ms rather than waiting a fixed time: the destination file appears
 * when the copy starts, so the signal lands at the beginning of a window that
 * `createBulkyDatabase` makes hundreds of milliseconds wide.
 */
export const runAndInterrupt = (script, args, env, { watchDir, signal = "SIGINT" }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const poll = setInterval(() => {
      if (fs.readdirSync(watchDir).length > 0) {
        clearInterval(poll);
        child.kill(signal);
      }
    }, 1);

    child.on("exit", (status, killedBy) => {
      clearInterval(poll);
      resolve({ status, signal: killedBy, stdout, stderr });
    });
  });

/**
 * The same shape as `runAndInterrupt` above, but waiting on a PREDICATE rather
 * than on "any file appeared in this empty directory".
 *
 * `encrypt-db.mjs` cannot use the directory form: its staging copy is born
 * beside the live database, in a directory that already holds `lawha.db` and
 * its sidecars, so `readdirSync(dir).length > 0` is true before the script has
 * done anything at all and the signal would land during Node's startup —
 * proving nothing about a window it never entered.
 *
 * `ready` is polled at 1ms and must not throw; anything it throws is treated
 * as "not ready yet", because the file it is looking at may be mid-creation.
 */
export const runAndInterruptWhen = (
  script,
  args,
  env,
  { ready, signal = "SIGTERM" },
) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, script), ...args],
      {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const poll = setInterval(() => {
      let isReady = false;
      try {
        isReady = ready();
      } catch {
        isReady = false;
      }
      if (isReady) {
        clearInterval(poll);
        child.kill(signal);
      }
    }, 1);

    child.on("exit", (status, killedBy) => {
      clearInterval(poll);
      resolve({ status, signal: killedBy, stdout, stderr });
    });
  });

export const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

/** `run`, but for a script that is not the one in this directory. */
export const runAt = (scriptPath, args, env = {}) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

/**
 * Copy `scripts` into a throwaway tree that mirrors the RUNTIME CONTAINER —
 * `better-sqlite3` resolvable and `better-sqlite3-multiple-ciphers` genuinely
 * absent — and return the directory they now live in.
 *
 * **This exists because a top-level `import` of the cipher driver took the
 * live deployment's scheduled backup down, and nothing in this repository
 * could see it.** `docker-compose.yml` mounts `./lawha-server/scripts` into
 * `lawha-backup` read-only, so these two files are the only part of the stack
 * served from the working tree rather than from an image. Their `node_modules`
 * is the image's, built whenever the image was last built — so a dependency
 * added to `package.json` today is NOT there tonight, and an ESM top-level
 * import of it fails before the module body runs at all: before argument
 * parsing, before `--help`, before every refusal the script contains.
 *
 * The layout is copied from the container rather than invented:
 * `/opt/lawha/node_modules` beside `/opt/lawha/scripts`, which is what Node's
 * resolver walks up into. Nothing above the temp directory has a
 * `node_modules` holding the cipher driver, so it is unresolvable for real —
 * this does not mock or intercept anything.
 *
 * `better-sqlite3` is SYMLINKED rather than copied because it carries a
 * compiled `.node` binding. Node resolves the symlink to its real path before
 * loading, so the package's own `require("bindings")` resolves from where it
 * actually lives and the native module loads normally — verified, not assumed.
 */
export const stageWithoutCipherDriver = (dir, scripts) => {
  const root = path.join(dir, "opt", "lawha");
  const scriptsDir = path.join(root, "scripts");
  const modulesDir = path.join(root, "node_modules");

  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(modulesDir, { recursive: true });

  fs.symlinkSync(
    createRequire(import.meta.url)
      .resolve("better-sqlite3")
      .replace(/\/lib\/index\.js$/, ""),
    path.join(modulesDir, "better-sqlite3"),
  );

  for (const script of scripts) {
    fs.copyFileSync(
      path.join(SCRIPTS_DIR, script),
      path.join(scriptsDir, script),
    );
  }

  return scriptsDir;
};

/**
 * The same run, but with stdout piped into `head`, which closes it part-way
 * through. `pipefail` is what makes the pipeline report the script's status
 * rather than `head`'s, so the exit code is the thing under test.
 */
export const runPipedToHead = (script, args, env = {}) =>
  spawnSync(
    "bash",
    [
      "-c",
      `set -o pipefail; "$0" "$@" | head -2`,
      process.execPath,
      path.join(SCRIPTS_DIR, script),
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );

/**
 * The same again, but with STDERR going into a consumer that has already gone
 * and stdout discarded, so the exit code is about the script's stderr writes
 * and nothing else.
 *
 * `2>&1 >/dev/null` in that order: `2>&1` points stderr at the current stdout
 * (the pipe), and only then is stdout sent to /dev/null. Written the other way
 * round it discards both. Sending stdout to /dev/null is what makes this
 * ISOLATE stderr — with both streams in the pipe, a present stdout handler
 * masks a missing stderr one.
 *
 * The consumer is `exec true` rather than `head -N`, and that is the
 * difference between a test and a coin toss. `head -2` also reproduces the
 * bug — it is the shape it was reported in — but only because the script
 * happens to write more than two lines before `head` gets round to exiting.
 * `true` closes the read end at pipeline setup, before node has booted, so
 * every stderr write faces a closed pipe. Measured 10/10 both ways, and this
 * one does not depend on how much the script printed.
 *
 * Exists for `encrypt-db.mjs`, which is the first script here to write
 * anything important to stderr on a SUCCESSFUL run — and where a bogus
 * non-zero exit is what sends an operator round a second time.
 */
export const runWithStderrClosed = (script, args, env = {}) =>
  spawnSync(
    "bash",
    [
      "-c",
      `set -o pipefail; "$0" "$@" 2>&1 >/dev/null | (exec true)`,
      process.execPath,
      path.join(SCRIPTS_DIR, script),
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );

/**
 * Row counts for the four tables both scripts report on.
 *
 * Opened read-write, not read-only: a read-only connection cannot create the
 * `-shm` a WAL database needs, and one of the restore tests reads a
 * pre-restore file that still has its `-wal` beside it.
 */
export const countsOf = (file) => {
  const db = new Database(file);
  const counts = Object.fromEntries(
    ["users", "boards", "board_scenes", "files"].map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
    ]),
  );
  db.close();
  return counts;
};

/**
 * The same four counts, read back through the pragma sequence `src/db/index.ts`
 * uses. Anything this can count, the server can open — which is the claim a
 * keyed backup or restore has to make good on, and the reason these tests count
 * rows through the KEY rather than trusting the script's own printed output.
 */
export const encryptedCountsOf = (file, key) => {
  const db = openEncrypted(file, key);
  const counts = Object.fromEntries(
    ["users", "boards", "board_scenes", "files"].map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
    ]),
  );
  db.close();
  return counts;
};

export const tableNames = (file) => {
  const db = new Database(file);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  db.close();
  return names;
};

export const backupsIn = (dir) =>
  fs.readdirSync(dir).filter((name) => /^lawha-\d{8}-\d{6}\.db$/.test(name));

/**
 * The same run as `run`, but with `input` written to the child's stdin and
 * then closed — the shape `restore.mjs`'s tests need to feed a private key
 * on stdin the way an operator piping `age-keygen`'s output into the command
 * would, without writing a temp file for it themselves.
 */
export const runWithStdin = (script, args, input, env = {}) =>
  spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });

/**
 * A real key pair, minted by `age-keygen` itself — not a fixture string —
 * because the round-trip tests this feeds exist to prove `restore.mjs`
 * produces (or consumes) something the real binary actually agrees is a
 * matching identity, not merely something shaped like one. Shared between
 * `backup.test.mjs` (which keeps its own older copy) and `restore.test.mjs`,
 * rather than tripled: this is the first time a THIRD file needs it.
 */
export const generateAgeKeypair = (dir) => {
  const keygen = spawnSync("age-keygen", [], { encoding: "utf8" });
  if (keygen.status !== 0) {
    throw new Error(`age-keygen failed: ${keygen.stderr}`);
  }

  const publicKeyLine = /^# public key: (age1[0-9a-z]{58})$/m.exec(
    keygen.stdout,
  );
  if (!publicKeyLine || !publicKeyLine[1]) {
    throw new Error(
      `could not find a public key line in age-keygen's output:\n${keygen.stdout}`,
    );
  }

  const identityFile = path.join(dir, "identity.txt");
  fs.writeFileSync(identityFile, keygen.stdout);

  return { recipient: publicKeyLine[1], identityFile };
};

/**
 * `age`'s own format signature, exactly as `AGE_MAGIC` in both `backup.mjs`
 * and `restore.mjs` check for it. A stand-in for "a real encrypted file",
 * good enough for tests that only need something `looksEncrypted()` accepts
 * — matching how `stageVerifiedBackup` stands in for a real plaintext backup.
 */
const AGE_MAGIC = "age-encryption.org/v1";

export const stageAgeArtifact = (
  dir,
  name,
  body = "stand-in ciphertext, not real age output",
) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${AGE_MAGIC}\n${body}\n`);
  return file;
};

/**
 * A stand-in for `age` that proves it has started — by creating
 * `startedMarker` — before sleeping far longer than any interrupt test needs
 * to wait, and only then producing output. Shared shape with the private copy
 * in `backup.test.mjs`, which predates this one; see the note on that file's
 * own copy for why the marker-poll technique exists instead of a fixed delay.
 */
export const writeSlowAgeStandIn = (dir, startedMarker) => {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "age");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `: > ${JSON.stringify(startedMarker)}`,
      "sleep 5",
      // Reached only if the test's signal was somehow never delivered.
      'printf "age-encryption.org/v1\\nnever reached in a passing run\\n"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(script, 0o755);
  return binDir;
};

/**
 * Runs `script` with the stand-in `age` above placed first on `PATH`, waits
 * for it to actually start — not a fixed delay, which would either flake
 * under a loaded machine or pad every run with dead time — then sends
 * `signal`. Generalises `backup.test.mjs`'s private
 * `runAndInterruptDuringEncryption` to any script that shells out to `age`,
 * so `restore.mjs`'s own interrupt-during-decrypt tests do not need a third
 * copy of this machinery.
 */
export const runAndInterruptWhileAgeRuns = (
  script,
  args,
  env,
  { workDir, signal = "SIGTERM" },
) =>
  new Promise((resolve) => {
    const startedMarker = path.join(workDir, "age-started");
    const binDir = writeSlowAgeStandIn(workDir, startedMarker);

    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, script), ...args],
      {
        env: {
          ...process.env,
          ...env,
          PATH: `${binDir}:${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const poll = setInterval(() => {
      if (fs.existsSync(startedMarker)) {
        clearInterval(poll);
        child.kill(signal);
      }
    }, 1);

    child.on("exit", (status, killedBy) => {
      clearInterval(poll);
      resolve({ status, signal: killedBy, stdout, stderr });
    });
  });
