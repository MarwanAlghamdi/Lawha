/**
 * Tests for `encrypt-db.mjs`, the one-way migration from a plaintext
 * `lawha.db` to a SQLCipher one.
 *
 * Two rules shape almost every assertion here.
 *
 * **Assert on bytes, not on names.** A file called `lawha.db` that still
 * begins `SQLite format 3` when the command said it encrypted one is the
 * failure this whole suite exists to catch, and no assertion about a
 * FILENAME can see it. So the checks below read the first sixteen bytes and
 * compare them to the magic itself, in both directions: the installed
 * database must NOT start with it, and the kept original must.
 *
 * **Never touch the real database.** Every fixture is built in a fresh temp
 * directory and `LAWHA_DB_PATH` is passed explicitly on every single run.
 * Nothing in this file may ever name `~/lawha-data`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";
import CipherDatabase from "better-sqlite3-multiple-ciphers";

import {
  SCRIPTS_DIR,
  countsOf,
  createAbandonedDatabase,
  createBulkyDatabase,
  createLiveDatabase,
  makeTempDir,
  run,
  runAndInterruptWhen,
  runPipedToHead,
  runWithStderrClosed,
  tableNames,
} from "./testSupport.mjs";

/**
 * Long enough to clear the floor `src/config.ts` enforces (16), and written
 * out rather than generated so a failure message shows the actual value.
 */
const KEY = "correct-horse-battery-staple";

/**
 * The first sixteen bytes of every unencrypted SQLite file — the same
 * constant, for the same reason, as `SQLITE_MAGIC` in `src/db/index.ts`.
 * SQLCipher encrypts the header along with everything else, so this is what
 * tells the two apart from outside, with no key and without opening anything.
 *
 * The NUL is written `\0` rather than pasted in literally: a raw NUL in the
 * source makes git call the file binary and stops the diff being reviewable.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

const firstBytes = (file, length = SQLITE_MAGIC.length) => {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString("latin1");
  } finally {
    fs.closeSync(handle);
  }
};

const readsAsPlaintextSqlite = (file) => firstBytes(file) === SQLITE_MAGIC;

/**
 * Row counts read back through the SAME pragma sequence `src/db/index.ts`
 * uses to open the live database — `cipher` first, then `key`, then a real
 * read. Anything this can count, the server can open.
 */
const encryptedCountsOf = (file, key, tables) => {
  const db = new CipherDatabase(file);
  db.pragma("cipher=sqlcipher");
  db.pragma(`key='${key.replace(/'/g, "''")}'`);
  // The probe read matters: `PRAGMA key` answers `ok` for any key at all,
  // because SQLCipher has not touched a page yet. Counting rows is what
  // actually proves the key is right.
  db.prepare("SELECT count(*) FROM sqlite_master").get();
  const names =
    tables ??
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  const counts = Object.fromEntries(
    names.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,
    ]),
  );
  db.close();
  return counts;
};

const temporaries = [];

const scratch = (prefix) => {
  const dir = makeTempDir(prefix);
  temporaries.push(dir);
  return dir;
};

/** Scratch copies of the script itself; see the mutation suite below. */
const mutants = [];

after(() => {
  for (const dir of temporaries) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const file of mutants) {
    fs.rmSync(file, { force: true });
  }
});

const ASIDE = "lawha.db.pre-encryption";

const source = fs.readFileSync(
  path.join(SCRIPTS_DIR, "encrypt-db.mjs"),
  "utf8",
);

describe("encrypt-db.mjs", () => {
  it("encrypts the database and keeps the plaintext original as .pre-encryption", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, {
      users: 6,
      boards: 10,
      scenes: 6,
      files: 5,
    });
    db.close();

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);

    // The claim, checked on the bytes: what is at `lawha.db` is no longer a
    // plain SQLite file, and it opens with the key.
    assert.ok(
      !readsAsPlaintextSqlite(dbPath),
      `${dbPath} still begins "SQLite format 3" — it was not encrypted`,
    );
    assert.deepEqual(encryptedCountsOf(dbPath, KEY), {
      users: 6,
      boards: 10,
      board_scenes: 6,
      files: 5,
    });

    // And the original is still there, still plaintext, still complete.
    const aside = path.join(dataDir, ASIDE);
    assert.ok(fs.existsSync(aside));
    assert.ok(readsAsPlaintextSqlite(aside));
    assert.deepEqual(countsOf(aside), {
      users: 6,
      boards: 10,
      board_scenes: 6,
      files: 5,
    });
  });

  it("compares every table it finds, not only the four it names", () => {
    // The four in COUNTED_TABLES are a wrong-file guard. The comparison that
    // decides whether the migration is allowed to stand has to cover whatever
    // the database actually holds, or a table lost in the copy would go
    // unnoticed by the one check written to notice exactly that.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.exec("CREATE TABLE tags (id TEXT PRIMARY KEY, label TEXT)");
    const insert = db.prepare("INSERT INTO tags VALUES (?, 'x')");
    for (let i = 0; i < 4; i += 1) {
      insert.run(`${i}`);
    }
    db.close();

    const before = tableNames(dbPath);
    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(encryptedCountsOf(dbPath, KEY).tags, 4);
    assert.deepEqual(
      Object.keys(encryptedCountsOf(dbPath, KEY)).sort(),
      before,
    );
    // The counts it printed have to name the extra table too, or the operator
    // reading the output has no way to see that it was considered.
    assert.match(result.stdout, /\btags\b/);
  });

  it("produces a database that cannot be read without the key", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 3 });
    db.close();

    assert.equal(
      run("encrypt-db.mjs", [], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      }).status,
      0,
    );

    // The plain driver — what `backup.mjs`, `restore.mjs` and six other
    // modules still use — must refuse it outright.
    const plain = new Database(dbPath);
    assert.throws(
      () => plain.prepare("SELECT count(*) FROM sqlite_master").get(),
      /not a database/,
    );
    plain.close();

    // And so must the right driver with the wrong key.
    const wrong = new CipherDatabase(dbPath);
    wrong.pragma("cipher=sqlcipher");
    wrong.pragma("key='a-different-key-entirely'");
    assert.throws(
      () => wrong.prepare("SELECT count(*) FROM sqlite_master").get(),
      /not a database/,
    );
    wrong.close();
  });

  it("leaves no -wal or -shm beside the encrypted database", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 3 });
    db.close();

    assert.equal(
      run("encrypt-db.mjs", [], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      }).status,
      0,
    );

    assert.ok(!fs.existsSync(`${dbPath}-wal`));
    assert.ok(!fs.existsSync(`${dbPath}-shm`));
    assert.deepEqual(
      fs.readdirSync(dataDir).filter((name) => name.includes(".encrypting-")),
      [],
    );
  });

  it("names a partial copy an earlier killed run left behind, and does not remove it", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    db.close();
    // What a SIGKILL during the copy leaves: a file nobody can account for,
    // sitting beside the database, several times its size.
    const orphan = path.join(dataDir, "lawha.db.encrypting-20260101-000000");
    fs.writeFileSync(orphan, "half a copy");

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /lawha\.db\.encrypting-20260101-000000/);
    // Named, not deleted. Nothing in this command removes a file it did not
    // create in this run.
    assert.equal(fs.readFileSync(orphan, "utf8"), "half a copy");
  });

  it("checkpoints first, so the kept original is not a bare 4KB header", () => {
    // The WAL hazard, from the other side. A server killed without closing
    // leaves every table in `lawha.db-wal` and a bare header in `lawha.db`;
    // moving `lawha.db` aside without checkpointing would keep that header
    // and call it a safety net.
    const dataDir = scratch("live");
    const dbPath = createAbandonedDatabase(dataDir, { users: 7, boards: 3 });

    assert.equal(fs.statSync(dbPath).size, 4096);
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);

    const aside = path.join(dataDir, ASIDE);
    assert.ok(fs.statSync(aside).size > 4096);
    assert.equal(countsOf(aside).users, 7);
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 7);
  });

  it("refuses while the database is held, and changes nothing", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 9 });
    // A held write transaction is a running server as far as the exclusive
    // claim is concerned. Encrypting under a live process would leave it
    // writing to a database that is no longer there.
    db.exec("BEGIN IMMEDIATE");

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    db.exec("ROLLBACK");
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /in use/);
    assert.ok(readsAsPlaintextSqlite(dbPath));
    assert.equal(countsOf(dbPath).users, 9);
    assert.ok(!fs.existsSync(path.join(dataDir, ASIDE)));
  });

  it("refuses a second run, and does not touch the original the first one kept", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 4, boards: 2 });
    db.close();

    assert.equal(
      run("encrypt-db.mjs", [], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      }).status,
      0,
    );

    const aside = path.join(dataDir, ASIDE);
    const asideBytes = fs.readFileSync(aside);
    const encryptedBytes = fs.readFileSync(dbPath);

    const second = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already encrypted/);
    // Byte-for-byte, both of them. A second run that "helpfully" re-encrypted
    // would overwrite the only plaintext copy of the data with a copy of the
    // ciphertext — the one way this command could still lose everything.
    assert.ok(fs.readFileSync(aside).equals(asideBytes));
    assert.ok(fs.readFileSync(dbPath).equals(encryptedBytes));
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 4);
  });

  it("refuses when a .pre-encryption file is already there, whatever the database looks like", () => {
    // The independent guard. The already-encrypted check above catches the
    // ordinary double run; this catches the one where somebody restored a
    // plaintext database over the top and ran it again, which would otherwise
    // write over the aside from the first run.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.close();
    fs.writeFileSync(path.join(dataDir, ASIDE), "an earlier original");

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pre-encryption/);
    assert.equal(
      fs.readFileSync(path.join(dataDir, ASIDE), "utf8"),
      "an earlier original",
    );
    assert.ok(readsAsPlaintextSqlite(dbPath));
  });

  it("refuses a file that is neither plaintext nor openable with this key", () => {
    const dataDir = scratch("live");
    const dbPath = path.join(dataDir, "lawha.db");
    // Encrypted with a DIFFERENT key: not plaintext, and this key will not
    // open it. Indistinguishable, from outside, from a damaged file — and the
    // message has to say so rather than guess.
    const other = new CipherDatabase(dbPath);
    other.pragma("cipher=sqlcipher");
    other.pragma("key='some-other-passphrase-entirely'");
    other.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    other.close();

    const before = fs.readFileSync(dbPath);
    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a plain SQLite database/);
    assert.match(result.stderr, /nothing has been changed/i);
    assert.ok(fs.readFileSync(dbPath).equals(before));
    assert.ok(!fs.existsSync(path.join(dataDir, ASIDE)));
  });

  it("refuses an empty file rather than reporting it as already encrypted", () => {
    // A zero-byte `lawha.db` has no magic in it, so the header check alone
    // reads it as "not plaintext"; and SQLite accepts ANY key against an
    // empty file, because there is no page to fail on. Without this guard the
    // two together report an empty file as already encrypted.
    const dataDir = scratch("live");
    const dbPath = path.join(dataDir, "lawha.db");
    fs.writeFileSync(dbPath, "");

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty/);
    assert.doesNotMatch(result.stderr, /already encrypted/);
  });

  it("refuses with no LAWHA_DB_KEY at all", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    db.close();

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAWHA_DB_KEY/);
    assert.ok(readsAsPlaintextSqlite(dbPath));
  });

  it("refuses a key the server itself would refuse to boot with", () => {
    // 15 characters, one under the floor in `src/config.ts`. Encrypting with
    // it would produce a database only a server that refuses to start can
    // open — and there is no second tool to undo it.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    db.close();

    const short = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "123456789012345",
    });

    assert.notEqual(short.status, 0);
    assert.match(short.stderr, /16/);
    assert.ok(readsAsPlaintextSqlite(dbPath));

    // And 16 is accepted, so the refusal is a floor and not an off-by-one.
    const exact = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "1234567890123456",
    });

    assert.equal(exact.status, 0, exact.stderr);
    assert.ok(!readsAsPlaintextSqlite(dbPath));
  });

  it("refuses a page size SQLCipher cannot rekey in place, before touching anything", () => {
    // Measured, not assumed: at `page_size = 512` the rekey reports `ok`,
    // rewrites the header, and produces a file the CORRECT key cannot open.
    // Every other power of two from 1024 to 65536 round-trips. Refusing up
    // front is better than discovering it at verification, because the
    // message can name the cause.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, {
      users: 2,
      pageSize: 512,
    });
    db.close();

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /page size/i);
    assert.match(result.stderr, /512/);
    assert.ok(readsAsPlaintextSqlite(dbPath));
    assert.equal(countsOf(dbPath).users, 2);
    assert.ok(!fs.existsSync(path.join(dataDir, ASIDE)));
  });

  it("tells the operator the original is kept and that removing it is theirs to do", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    db.close();

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.pre-encryption/);
    assert.match(result.stdout, /by hand/);
    assert.match(result.stdout, /never delete/i);
  });

  it("tells the operator how to recover when lawha.db is gone and the aside is there", () => {
    // The state a SIGKILL between the two renames leaves, staged directly
    // because it cannot be produced on demand. Review reproduced it and found
    // the command answered with one line — "no such database" — while the
    // operator's entire deployment sat complete in the same directory under a
    // different name. This is the moment they most need to be told something.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 6, boards: 4 });
    db.close();
    const aside = path.join(dataDir, ASIDE);
    fs.renameSync(dbPath, aside);
    const partial = path.join(dataDir, "lawha.db.encrypting-20260101-000000");
    fs.writeFileSync(partial, "the interrupted copy");

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    // Both files named, so nothing in that directory is unexplained.
    assert.match(result.stderr, /lawha\.db\.pre-encryption IS there/);
    assert.match(result.stderr, /lawha\.db\.encrypting-20260101-000000/);
    assert.match(result.stderr, /nothing was lost/);
    // The recovery, spelled out as a command rather than described. Whoever
    // reads this has just lost a file they cannot afford to lose.
    assert.match(result.stderr, new RegExp(`mv ${aside} ${dbPath}`));
    // And it is still a refusal: nothing was moved on their behalf.
    assert.ok(!fs.existsSync(dbPath));
    assert.equal(countsOf(aside).users, 6);
    assert.equal(fs.readFileSync(partial, "utf8"), "the interrupted copy");
  });

  it("round-trips a key containing a single quote, and only that key opens it", () => {
    // `keyLiteral` here and `keyPragma` in `src/db/index.ts` are separate
    // copies of the same SQL-literal escaping, and if they ever disagree this
    // command encrypts with one key while the server opens with another —
    // producing a database nothing can read, which is the exact failure the
    // whole plan exists to prevent, arrived at from the other side.
    //
    // A key with no quote in it cannot detect that: review replaced the
    // escaping with the bare key and every test still passed. This one uses a
    // quote and verifies with an INDEPENDENT escaping that mirrors the
    // server's, so an edit that strips quotes instead of doubling them —
    // which would self-verify perfectly inside the script — fails here.
    const quoted = "pass'word-with-a-quote-in-it";
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 5 });
    db.close();

    const result = run("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: quoted,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(encryptedCountsOf(dbPath, quoted).users, 5);

    // And the prefix an unescaped literal would have truncated it to opens
    // nothing — so "it worked" cannot mean "it encrypted with `pass`".
    const truncated = new CipherDatabase(dbPath);
    truncated.pragma("cipher=sqlcipher");
    truncated.pragma("key='pass'");
    assert.throws(
      () => truncated.prepare("SELECT count(*) FROM sqlite_master").get(),
      /not a database/,
    );
    truncated.close();
  });

  it("survives having its stdout closed part-way through", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    db.close();

    const result = runPipedToHead("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    // EPIPE is not a failure of the work — the same handler both other
    // scripts carry, for the same reason.
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!readsAsPlaintextSqlite(dbPath));
  });

  it("survives having its stderr closed part-way through", () => {
    // `backup.mjs` and `restore.mjs` both guard stdout and neither guards
    // stderr, so this shape was inherited rather than invented — but it bites
    // here and not there, because this is the first of the three to write
    // something important to stderr on a SUCCESSFUL run. Review reproduced
    // it: `2>&1 | head` returned 1 after a migration that had completed.
    //
    // A spurious non-zero exit from THIS command is worse than from any
    // other: it is what sends the operator round again, into the second run
    // that finds `.pre-encryption` in the way.
    //
    // The helper closes stderr's reader outright rather than using `head`;
    // see its own comment for why `head` here is a race and this is not.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.close();

    const result = runWithStderrClosed("encrypt-db.mjs", [], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stdout);
    // The work itself still happened — a passing exit code proves nothing on
    // its own here.
    assert.ok(!readsAsPlaintextSqlite(dbPath));
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 2);
  });
});

/**
 * Several of this script's checks are safety nets for causes nobody can
 * enumerate — a short copy, a rekey that dropped pages, a bug in a future
 * edit. A page-for-page copy plus an in-place rekey cannot change a row count
 * or a schema, so there is no fixture that makes those checks fire honestly:
 * left alone, each is a layer that could be deleted tomorrow with a green
 * suite. Review confirmed exactly that, by deleting four of them.
 *
 * So the fault is injected. A COPY of the script is taken with one call site
 * surgically altered, and that copy is run. `stageMutant` asserts the target
 * is still present AND that the replacement changed something, so a mutation
 * test can never quietly pass by failing to mutate anything — which is the
 * failure mode that makes this technique worthless if it is not guarded.
 *
 * The copy lives beside the original because it has to resolve
 * `better-sqlite3` from the same `node_modules`, and its name cannot match
 * `scripts/*.test.mjs` or `node --test` would try to run it.
 */
const stageMutant = (target, replacement) => {
  assert.ok(
    source.includes(target),
    `the mutation target is gone from encrypt-db.mjs: ${target}`,
  );
  const mutated = source.replace(target, replacement);
  assert.notEqual(mutated, source, "the mutation did not apply");

  // Swept before writing as well as removed after, because `after()` does not
  // run if the process is killed — and a stale mutant sitting in `scripts/`
  // is exactly the kind of untracked file somebody else's `git add -A` picks
  // up and commits.
  for (const stale of fs.readdirSync(SCRIPTS_DIR)) {
    if (stale.startsWith(".encrypt-db.mutant-")) {
      fs.rmSync(path.join(SCRIPTS_DIR, stale), { force: true });
    }
  }

  const name = `.encrypt-db.mutant-${process.pid}-${mutants.length}.mjs`;
  const file = path.join(SCRIPTS_DIR, name);
  fs.writeFileSync(file, mutated);
  mutants.push(file);
  return name;
};

/**
 * The shared shape of every mutation test below: a plaintext database, a
 * mutated script run against it, and the assertion that matters most — the
 * original is byte-for-byte where it was, still plaintext, never moved aside,
 * and no staging copy left behind.
 */
const assertRefusedWithOriginalIntact = (result, dataDir, dbPath, before) => {
  assert.notEqual(result.status, 0, `expected a refusal:\n${result.stdout}`);
  assert.ok(readsAsPlaintextSqlite(dbPath));
  assert.ok(fs.readFileSync(dbPath).equals(before));
  assert.ok(!fs.existsSync(path.join(dataDir, ASIDE)));
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((name) => name.includes(".encrypting-")),
    [],
  );
};

describe("encrypt-db.mjs — a row-count mismatch", () => {
  it("refuses outright and leaves the plaintext original exactly where it was", () => {
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 5, boards: 2 });
    db.close();
    const before = fs.readFileSync(dbPath);

    const result = run(
      stageMutant(
        "const stagedCounts = countTables(staged, sourceTables);",
        "const stagedCounts = countTables(staged, sourceTables)" +
          ".map(([table, n]) => [table, n + 1]);",
      ),
      [],
      {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      },
    );

    assert.match(result.stderr, /does not match/);
    // Named per table, so the operator can see WHICH one drifted.
    assert.match(result.stderr, /users/);
    assertRefusedWithOriginalIntact(result, dataDir, dbPath, before);
  });

  it("refuses when the schema of the copy does not match the source", () => {
    // Counts alone would not notice an index or a trigger that failed to come
    // across. Review deleted this comparison and all 27 tests stayed green.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.close();
    const before = fs.readFileSync(dbPath);

    const result = run(
      stageMutant(
        "const stagedSchema = schemaOf(staged);",
        'const stagedSchema = schemaOf(staged) + "\\nindex lost";',
      ),
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
    );

    assert.match(result.stderr, /same schema/);
    assertRefusedWithOriginalIntact(result, dataDir, dbPath, before);
  });

  it("refuses when integrity_check on the encrypted copy is not ok", () => {
    // A fifth layer, found by sweeping the same mutation over every check
    // rather than only the four review named. It survived too, so it gets the
    // same treatment.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.close();
    const before = fs.readFileSync(dbPath);

    const result = run(
      stageMutant(
        'const stagedIntegrity = staged.pragma("integrity_check")[0]?.integrity_check;',
        'const stagedIntegrity = "malformed database schema";',
      ),
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
    );

    assert.match(result.stderr, /integrity_check on the encrypted copy/);
    assertRefusedWithOriginalIntact(result, dataDir, dbPath, before);
  });

  it("refuses when the encrypted copy will not open with the key", () => {
    // This is the layer that catches the 512-byte-page trap and every other
    // way `PRAGMA rekey` can answer `ok` and produce something unopenable.
    // Mutated by verifying with a DIFFERENT key, which is what "the rekey
    // used a key nobody can reproduce" looks like from here.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });
    db.close();
    const before = fs.readFileSync(dbPath);

    const result = run(
      stageMutant(
        "const staged = openEncrypted(stagingPath, key);",
        "const staged = openEncrypted(stagingPath, `${key}-not-the-key`);",
      ),
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
    );

    assert.match(result.stderr, /does not open with LAWHA_DB_KEY/);
    assertRefusedWithOriginalIntact(result, dataDir, dbPath, before);
  });

  it("refuses after the install when what landed does not match, and says where the data is", () => {
    // The one mutation whose refusal happens AFTER the move-aside, so it
    // cannot use `assertRefusedWithOriginalIntact`: by then `lawha.db` is the
    // encrypted copy and the plaintext original is at `.pre-encryption`. What
    // this proves is that the operator is told exactly that.
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 3, boards: 1 });
    db.close();

    const result = run(
      stageMutant(
        "  installedCounts = countTables(installed, sourceTables);",
        "  installedCounts = countTables(installed, sourceTables)" +
          ".map(([table, n]) => [table, n + 1]);",
      ),
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /what landed at .* does not match/);
    // The recovery sentence, and the file it names, are the whole value of
    // this refusal — the data is not where the operator left it.
    assert.match(result.stderr, /your data is safe at .*\.pre-encryption/);

    const aside = path.join(dataDir, ASIDE);
    assert.ok(readsAsPlaintextSqlite(aside));
    assert.equal(countsOf(aside).users, 3);
  });
});

/**
 * Interrupts.
 *
 * The window that matters is between the original being moved aside and the
 * encrypted copy being installed, and it cannot be entered by a signal: that
 * stretch is synchronous throughout with no yield point between
 * them, so a JS handler registered for SIGINT/SIGTERM cannot run inside it.
 * (`restore.mjs`'s header explains the same property at length, and the
 * structural suite below pins it mechanically rather than trusting this
 * paragraph.)
 *
 * What CAN be interrupted is the copy — `db.backup()` yields to the event
 * loop every 100 pages — and that is entirely before anything about the live
 * database has moved. Both tests below fire while the staging copy is being
 * written, one with a signal the script handles and one with SIGKILL, which
 * it cannot.
 *
 * Both assert the same two-state invariant, on BYTES, because neither can
 * pin down exactly where the signal landed: `lawha.db` is either the
 * untouched plaintext original with every row still in it, or the finished
 * ciphertext with the original kept beside it. There is no third state, and
 * in particular there is no state where `lawha.db` is plaintext while the
 * command claims to have encrypted it.
 */
describe("encrypt-db.mjs — interrupted while the copy is being written", () => {
  const stagingAppeared = (dir) => () =>
    fs.readdirSync(dir).some((name) => name.includes(".encrypting-"));

  const assertConsistent = (dataDir, dbPath) => {
    const aside = path.join(dataDir, ASIDE);

    /**
     * The third state, named rather than crashed on.
     *
     * `lawha.db` absent means SIGKILL landed between the two renames — the
     * window a signal cannot enter but a `kill -9` can, being a handful of
     * instructions wide. It is a REAL state and it is recoverable: the data
     * is complete at `.pre-encryption` and one `mv` puts it back, which is
     * what the script's own "no such database" branch now tells the operator.
     *
     * Before this branch existed, `firstBytes` threw ENOENT here and the test
     * ERRORED instead of asserting — so the one outcome this suite exists to
     * describe would have been reported as a broken test.
     */
    if (!fs.existsSync(dbPath)) {
      assert.ok(
        fs.existsSync(aside),
        `${dbPath} is gone and ${aside} does not exist — that is data loss, ` +
          "not an interrupted run",
      );
      assert.ok(readsAsPlaintextSqlite(aside));
      assert.equal(countsOf(aside).users, 3);
      return "interrupted-mid-swap";
    }

    if (readsAsPlaintextSqlite(dbPath)) {
      // Untouched. Then the aside must not exist — its existence beside a
      // plaintext `lawha.db` would mean the original was moved and something
      // plaintext was put back in its place.
      assert.ok(
        !fs.existsSync(aside),
        `${dbPath} is plaintext but ${aside} exists — the original was moved ` +
          "aside and a plaintext file is wearing the live database's name",
      );
      assert.equal(countsOf(dbPath).users, 3);
      return "untouched";
    }

    // Finished. Then it opens with the key, and the plaintext original is
    // kept beside it.
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 3);
    assert.ok(fs.existsSync(aside), "the original was not kept");
    assert.ok(readsAsPlaintextSqlite(aside));
    assert.equal(countsOf(aside).users, 3);
    return "finished";
  };

  it("leaves the plaintext original in place when SIGTERM lands mid-copy", async () => {
    const dataDir = scratch("live");
    const dbPath = createBulkyDatabase(dataDir, {
      rows: 12000,
      users: 3,
      pageSize: 4096,
    });

    const result = await runAndInterruptWhen(
      "encrypt-db.mjs",
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
      { ready: stagingAppeared(dataDir), signal: "SIGTERM" },
    );

    const state = assertConsistent(dataDir, dbPath);

    if (state === "untouched") {
      // 128+15, what a shell reports for a SIGTERMed process — the same
      // convention `backup.mjs` and `restore.mjs` use.
      assert.equal(result.status, 143);
      assert.match(result.stderr, /interrupted by SIGTERM/);
      assert.match(result.stderr, /nothing was changed/);
      // The failure this assertion exists for: saying "nothing was changed"
      // while something was. Covered by assertConsistent above, on bytes.

      // A handled interrupt runs the exit handler, so it must take its
      // scratch WITH it — sidecars included. Measured before this was
      // asserted: the staging copy was removed and its `-journal` was left
      // behind, a dangling sidecar beside a name that no longer existed.
      assert.deepEqual(
        fs.readdirSync(dataDir).filter((name) => name.includes(".encrypting-")),
        [],
      );
    }
  });

  it("leaves the plaintext original in place when SIGKILL lands mid-copy", async () => {
    // SIGKILL cannot be handled, so this is the honest worst case: the
    // process stops between two machine instructions with nothing able to
    // run afterwards. It is survivable only because `lawha.db` is never
    // written to — it is renamed away, once, at the very end.
    const dataDir = scratch("live");
    const dbPath = createBulkyDatabase(dataDir, {
      rows: 12000,
      users: 3,
      pageSize: 4096,
    });

    await runAndInterruptWhen(
      "encrypt-db.mjs",
      [],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
      { ready: stagingAppeared(dataDir), signal: "SIGKILL" },
    );

    assertConsistent(dataDir, dbPath);
  });
});

/**
 * Properties no behavioural test can force through execution, checked on the
 * script's own source instead — the technique `restore.test.mjs` already uses
 * for the same reason, and for the same window.
 */
describe("encrypt-db.mjs — structural safety invariants", () => {
  it("has no yield point between the move-aside and the install", () => {
    // This is the whole argument that a signal cannot land in the dangerous
    // window. A JS signal handler only runs when the current synchronous
    // stretch finishes or yields; if there is no `await` between these two
    // renames, there is nothing for it to interleave with. Adding one later
    // would re-open a window that nothing else in this file guards.
    const movedAside = source.indexOf("fs.renameSync(dbPath, aside);");
    const installed = source.indexOf("fs.renameSync(stagingPath, dbPath);");
    assert.ok(movedAside > 0, "the move-aside is not where this test expects");
    assert.ok(installed > movedAside, "the install does not follow it");

    assert.doesNotMatch(
      source.slice(movedAside, installed),
      /\bawait\b/,
      "an await between the move-aside and the install lets a signal handler " +
        "run while lawha.db does not exist",
    );
  });

  it("never writes to dbPath — the only thing that lands there is a rename", () => {
    // `fs.copyFileSync` is not atomic. A copy straight onto `dbPath` could be
    // interrupted mid-write and leave a half-written file wearing the live
    // database's own name; a rename on the same filesystem cannot.
    assert.doesNotMatch(
      source,
      /fs\.(copyFileSync|writeFileSync)\([^)]*dbPath\)/,
    );
    assert.match(source, /fs\.renameSync\(stagingPath, dbPath\);/);
  });

  it("tracks its phase right where the phase changes", () => {
    assert.match(
      source,
      /fs\.renameSync\(dbPath, aside\);\s*\n\s*phase = "moved-aside";/,
    );
    assert.match(
      source,
      /fs\.renameSync\(stagingPath, dbPath\);\s*\n\s*phase = "installed";/,
    );
    assert.match(source, /phase === "moved-aside"/);
    assert.match(source, /phase === "installed"/);
  });

  it("wraps the install in a try that reuses the interrupt handler's recovery sentence", () => {
    // `restore.mjs` shipped without this and review found it: the failure a
    // signal cannot reach here — a full disk, a permissions error — had no
    // handler above it, so it surfaced as a raw V8 stack trace with the live
    // database renamed away and nothing printed about where it went, while
    // the recovery sentence written for exactly that state hung off a signal
    // branch that could never fire. That failure cannot be forced through
    // execution in this suite (dbPath and stagingPath share a directory, so
    // anything that blocks the install blocks the move-aside a moment
    // earlier, which is a different and already-safe path), so it is pinned
    // structurally instead.
    const movedAside = source.indexOf("fs.renameSync(dbPath, aside);");
    const afterInstall = source.indexOf(
      "could not install the encrypted database",
    );
    assert.ok(afterInstall > movedAside, "the install has no catch of its own");
    assert.match(
      source.slice(movedAside, afterInstall + 400),
      /\$\{asideRecoveryAdvice\(\)\}/,
    );

    // The read-back after the install is inside a try for the same reason and
    // cannot be discriminated by running anything: `openEncrypted` has already
    // proved the file opens, so reaching this catch needs a disk error
    // mid-read. Pinned textually, which is what fails if someone unwraps it.
    assert.match(
      source,
      /try \{\n\s*installedCounts = countTables\(installed, sourceTables\);/,
      "the post-install read-back must stay inside its try — it runs after " +
        "the original has been moved aside",
    );

    // One function, read from the signal handler and from every failure that
    // leaves the operator's data at the aside — not copies that can drift.
    assert.equal(
      (source.match(/const asideRecoveryAdvice = /g) ?? []).length,
      1,
      "asideRecoveryAdvice must be defined exactly once",
    );
    assert.ok(
      (source.match(/\$\{asideRecoveryAdvice\(\)\}/g) ?? []).length >= 2,
      "the recovery sentence must be shared, not written once and copied",
    );
  });

  it("registers the same three signals both other scripts do", () => {
    assert.match(
      source,
      /const INTERRUPTS = \{ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 \};/,
    );
  });

  it("never removes the database, the aside, or anything but its own scratch", () => {
    // The discipline this whole command is built on. Nothing here may delete
    // a database: the operator does that, by hand, once they are satisfied.
    const removals = source.match(/fs\.(rmSync|unlinkSync)\([^)]*\)/g) ?? [];
    for (const removal of removals) {
      assert.doesNotMatch(
        removal,
        /\baside\b/,
        `${removal} can remove the plaintext original`,
      );
      assert.doesNotMatch(
        removal,
        /\bdbPath\)/,
        `${removal} can remove the live database`,
      );
    }
  });

  it("keys its floor to the one src/config.ts actually enforces", () => {
    // A duplicated constant is pinned where it is USED — but the cost of
    // these two drifting apart is a database encrypted with a key the server
    // refuses to boot with, so they are compared directly rather than left to
    // two independent literals.
    const config = fs.readFileSync(
      path.join(SCRIPTS_DIR, "..", "src", "config.ts"),
      "utf8",
    );
    const inConfig = /const MIN_DB_KEY_LENGTH = (\d+);/.exec(config)?.[1];
    const inScript = /const MIN_DB_KEY_LENGTH = (\d+);/.exec(source)?.[1];

    assert.ok(inConfig, "src/config.ts no longer declares MIN_DB_KEY_LENGTH");
    assert.equal(
      inScript,
      inConfig,
      "encrypt-db.mjs would accept a key the server refuses to boot with",
    );
  });

  it("escapes the key exactly the way src/db/index.ts does", () => {
    // Pinned beside MIN_DB_KEY_LENGTH above and for the same reason: two
    // copies of one rule, where drift produces a database encrypted with a
    // key the server cannot reconstruct. The round-trip test above catches a
    // difference in BEHAVIOUR; this catches a difference in the TEXT, and
    // says in one line which file the other copy is in — which is what a
    // future reader needs before they touch either.
    const dbIndex = fs.readFileSync(
      path.join(SCRIPTS_DIR, "..", "src", "db", "index.ts"),
      "utf8",
    );
    const escape = /key\.replace\((\/'\/g), ("''")\)/;
    const inServer = escape.exec(dbIndex)?.[0];
    const inScript = escape.exec(source)?.[0];

    assert.ok(
      inServer,
      "src/db/index.ts no longer escapes the key the way this expects — " +
        "check keyPragma there before changing this test",
    );
    assert.equal(
      inScript,
      inServer,
      "encrypt-db.mjs would encrypt with a key src/db/index.ts cannot " +
        "reconstruct",
    );
  });

  it("checkpoints before the copy — a layer no behavioural test can discriminate", () => {
    /**
     * This is the one of the four redundant layers that CANNOT be caught by
     * running anything, and saying so is more honest than a test that passes
     * either way.
     *
     * Measured: with the pragma deleted, an abandoned database (every table
     * in the `-wal`, a bare 4KB header in `lawha.db`) still migrates
     * perfectly and the kept original still holds all seven accounts —
     * because `live.close()` checkpoints on its way out regardless. The
     * existing "checkpoints first" test above passes without the pragma, and
     * review was right to say it does not discriminate.
     *
     * What the pragma actually buys is independence from that: the guarantee
     * becomes a property of this file rather than of `close()`'s behaviour,
     * and it survives anyone reordering the close past the rename. Deleting
     * it would be silent today and load-bearing the moment that happens.
     *
     * So it is pinned textually, including its position — which does fail if
     * the line is removed, and is the strongest thing available here.
     */
    const checkpoint = source.indexOf(
      'live.pragma("wal_checkpoint(TRUNCATE)");',
    );
    const backup = source.indexOf("await live.backup(stagingPath);");
    assert.ok(checkpoint > 0, "the checkpoint before the copy is gone");
    assert.ok(
      backup > checkpoint,
      "the checkpoint must come before the copy and the move-aside",
    );
  });

  it("proves the key with a real read, not with what PRAGMA key answers", () => {
    // SQLCipher answers `ok` to `PRAGMA key` for any value at all, because it
    // has not read a page yet. Trusting that answer would mean verifying the
    // migration against a database nothing ever opened.
    const cipherPragma = source.indexOf('pragma("cipher=sqlcipher")');
    const probe = source.indexOf("SELECT count(*) FROM sqlite_master");
    assert.ok(cipherPragma > 0 && probe > cipherPragma);
    assert.match(source, /PRAGMA key/);
  });
});
