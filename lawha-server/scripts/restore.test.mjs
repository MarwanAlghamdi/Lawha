import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  SCRIPTS_DIR,
  backupsIn,
  countsOf,
  createAbandonedDatabase,
  createEncryptedLiveDatabase,
  createLiveDatabase,
  encryptedCountsOf,
  generateAgeKeypair,
  makeTempDir,
  readsAsPlaintextSqlite,
  run,
  runAndInterruptWhileAgeRuns,
  runAt,
  runPipedToHead,
  runWithStdin,
  stageAgeArtifact,
  stageWithoutCipherDriver,
} from "./testSupport.mjs";

const temporaries = [];

const scratch = (prefix) => {
  const dir = makeTempDir(prefix);
  temporaries.push(dir);
  return dir;
};

after(() => {
  for (const dir of temporaries) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A verified backup file holding `users` accounts, taken the supported way. */
const takeBackup = (users) => {
  const dataDir = scratch("source");
  const outDir = scratch("archive");
  const { dbPath, db } = createLiveDatabase(dataDir, { users, boards: 1 });

  const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
  db.close();

  assert.equal(result.status, 0, result.stderr);
  return path.join(outDir, backupsIn(outDir)[0]);
};

const asideIn = (dir) =>
  fs.readdirSync(dir).filter((name) => name.includes(".pre-restore-"));

describe("restore.mjs", () => {
  it("installs the backup and keeps the old database as .pre-restore-<stamp>", () => {
    const backup = takeBackup(2);
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 5, boards: 4 });
    db.close();

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(countsOf(dbPath).users, 2);

    // Nothing is ever deleted: the five accounts that were there are still on
    // disk, readable, under a name that says what they are.
    const [aside] = asideIn(dataDir);
    assert.match(aside, /^lawha\.db\.pre-restore-\d{8}-\d{6}$/);
    assert.deepEqual(countsOf(path.join(dataDir, aside)), {
      users: 5,
      boards: 4,
      board_scenes: 0,
      files: 0,
    });
  });

  it("checkpoints before moving aside, so the kept copy is not a bare header", () => {
    // The WAL hazard on the restore side: every table is in `lawha.db-wal` when
    // restore runs, so moving `lawha.db` alone would keep a 4KB header and call
    // it a safety net.
    //
    // The state is staged by killing a stand-in server rather than by holding
    // the connection open here, because an open connection is a running server
    // and restore now refuses to run under one — which is the whole of finding
    // 3. Killed-without-closing is also how the live rehearsal produced it.
    const backup = takeBackup(1);
    const dataDir = scratch("live");
    const dbPath = createAbandonedDatabase(dataDir, { users: 7, boards: 3 });

    // The fixture is only the hazard if the pages really are in the sidecar,
    // and opening the database to check would checkpoint them away. Sizes say
    // it without touching anything: a bare header, and a sidecar with content.
    assert.equal(fs.statSync(dbPath).size, 4096);
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);

    const [aside] = asideIn(dataDir);
    assert.equal(countsOf(path.join(dataDir, aside)).users, 7);
    assert.equal(countsOf(dbPath).users, 1);
  });

  it("leaves no orphaned -wal or -shm behind the restored database", () => {
    const backup = takeBackup(1);
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 3 });
    db.close();

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(`${dbPath}-wal`));
    assert.ok(!fs.existsSync(`${dbPath}-shm`));
  });

  it("refuses while the database is in use, and moves nothing", () => {
    const backup = takeBackup(1);
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 9 });
    // A held write transaction is a running server, as far as the checkpoint
    // is concerned. Installing a file under a live process would leave it
    // writing to a database that is no longer there.
    db.exec("BEGIN IMMEDIATE");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    db.exec("ROLLBACK");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /in use — stop the server first/);
    assert.deepEqual(asideIn(dataDir), []);
    assert.equal(countsOf(dbPath).users, 9);
    db.close();
  });

  it("refuses while an idle server merely has the database open", () => {
    // The test above holds a write transaction, which is a server mid-save. A
    // server nobody is drawing on holds NO lock at all, and that is the case
    // the old check could not see: `PRAGMA wal_checkpoint(TRUNCATE)` reports
    // `busy` only for a transaction in flight, so an idle connection yielded
    // `busy: 0` and the restore renamed the live database out from under a
    // running process without a word. Reproduced before this test existed: the
    // server carried on reading its nine accounts and wrote a new board into
    // the `-wal` this script then unlinked.
    const backup = takeBackup(1);
    const dataDir = scratch("live");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 9 });

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /in use — stop the server first/);
    assert.deepEqual(asideIn(dataDir), []);
    // The connection that was open all along still sees its own data, and the
    // refusal cost it nothing.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 9);
    db.close();
    assert.equal(countsOf(dbPath).users, 9);
  });

  it("does not recover a foreign -wal left where the database used to be", () => {
    // `backup.mjs` already names this hazard from the archive side — a stray
    // `-wal` beside a deleted `.db` is how a later restore picks up somebody
    // else's pages — and this file guards the mirror case on the backup
    // ARTEFACT. The target side had no guard at all, so with `lawha.db` deleted
    // by hand (or after an interrupt between the move-aside and the sidecar
    // handling) SQLite recovered the orphan's frames into the freshly copied
    // backup: WAL frame checksums are seeded from the WAL header's own salt, so
    // frames from an unrelated database validate perfectly.
    const backup = takeBackup(1);

    const foreignDir = scratch("foreign");
    const { dbPath: foreign, db: foreignDb } = createLiveDatabase(foreignDir, {
      users: 5,
    });

    const target = scratch("target");
    const dbPath = path.join(target, "lawha.db");
    // Every page of the five-account database is still in its sidecar, because
    // the connection is open and nothing has checkpointed.
    fs.copyFileSync(`${foreign}-wal`, `${dbPath}-wal`);
    foreignDb.close();

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);
    // The one account that was verified is what landed. This read used to
    // return 5, and inspect()'s own close then checkpointed the evidence away.
    assert.equal(countsOf(dbPath).users, 1);
    assert.match(result.stderr, /was there with no database beside it/);

    // Nothing is deleted, here as everywhere else in this script: the orphan is
    // kept under a name that says what it is.
    const kept = fs
      .readdirSync(target)
      .filter((name) => name.includes(".orphaned-wal-"));
    assert.equal(kept.length, 1, fs.readdirSync(target).join(", "));
  });

  it("refuses a backup that is only the 4KB header a file copy produces", () => {
    const dataDir = scratch("live");
    const archive = scratch("archive");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 4 });

    // Exactly what `cp lawha.db` yields against a live WAL database, which is
    // the artefact that destroyed this deployment once already.
    const copied = path.join(archive, "lawha-19700101-000000.db");
    fs.copyFileSync(dbPath, copied);
    db.close();

    const target = scratch("target");
    const result = run("restore.mjs", [copied], {
      LAWHA_DB_PATH: path.join(target, "lawha.db"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has no users, boards, board_scenes, files/);
  });

  it("refuses a backup whose -wal still holds pages", () => {
    const dataDir = scratch("live");
    const archive = scratch("archive");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 4 });

    const copied = path.join(archive, "lawha-19700101-000000.db");
    fs.copyFileSync(dbPath, copied);
    fs.copyFileSync(`${dbPath}-wal`, `${copied}-wal`);
    db.close();

    const target = scratch("target");
    const result = run("restore.mjs", [copied], {
      LAWHA_DB_PATH: path.join(target, "lawha.db"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only part of a database/);
  });

  it("restores into an empty directory with nothing to move aside", () => {
    const backup = takeBackup(6);
    const target = scratch("target");
    const dbPath = path.join(target, "fresh", "lawha.db");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(countsOf(dbPath).users, 6);
    assert.match(result.stdout, /restoring into an empty spot/);
  });

  it("still exits zero when stdout is piped into head", () => {
    // A completed restore reported as a failure is worse here than in backup:
    // it invites somebody to run the whole thing again against a database that
    // has already been replaced. See the matching test in backup.test.mjs.
    const backup = takeBackup(3);
    const target = scratch("target");
    const dbPath = path.join(target, "lawha.db");

    const result = runPipedToHead("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(countsOf(dbPath).users, 3);
  });

  it("exits non-zero when the backup does not exist", () => {
    const target = scratch("target");

    const result = run("restore.mjs", [path.join(target, "absent.db")], {
      LAWHA_DB_PATH: path.join(target, "lawha.db"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no such backup/);
  });
});

/**
 * `age` and `age-keygen` are needed only by the tests below that actually
 * encrypt and decrypt for real. Same detection as `backup.test.mjs`'s own
 * copy — synchronous, because `describe` bodies all run before any `it` does.
 */
const ageAvailable = spawnSync("age", ["--version"]).status === 0;

if (!ageAvailable) {
  process.stderr.write(
    "\n!!! restore.mjs age round-trip tests DID NOT RUN !!!\n" +
      "    `age` is not on PATH in this environment.\n" +
      "    Nothing below encrypted or decrypted anything for real.\n\n",
  );
}

describe(
  "restore.mjs — decrypting an encrypted backup",
  { skip: !ageAvailable && "age is not on PATH in this environment" },
  () => {
    /** An encrypted backup, taken the supported way, plus the key that opens it. */
    const takeEncryptedBackup = (users, keyDir) => {
      const dataDir = scratch("source");
      const outDir = scratch("archive");
      const { dbPath, db } = createLiveDatabase(dataDir, { users, boards: 2 });
      const { recipient, identityFile } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.equal(result.status, 0, result.stderr);
      const [name] = fs
        .readdirSync(outDir)
        .filter((entry) => entry.endsWith(".db.age"));
      assert.ok(name, `no .db.age written: ${result.stdout}${result.stderr}`);

      return { backup: path.join(outDir, name), identityFile, recipient };
    };

    it("restores with --identity <path>, matching the backup's row counts", () => {
      const keyDir = scratch("keys");
      const { backup, identityFile } = takeEncryptedBackup(3, keyDir);
      const target = scratch("target");
      const dbPath = path.join(target, "lawha.db");

      const result = run("restore.mjs", [backup, "--identity", identityFile], {
        LAWHA_DB_PATH: dbPath,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /decrypting/);
      assert.deepEqual(countsOf(dbPath), {
        users: 3,
        boards: 2,
        board_scenes: 0,
        files: 0,
      });
    });

    it("restores with the identity piped on stdin, not just --identity", () => {
      const keyDir = scratch("keys");
      const { backup, identityFile } = takeEncryptedBackup(4, keyDir);
      const target = scratch("target");
      const dbPath = path.join(target, "lawha.db");
      const identity = fs.readFileSync(identityFile, "utf8");

      const result = runWithStdin("restore.mjs", [backup], identity, {
        LAWHA_DB_PATH: dbPath,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(countsOf(dbPath).users, 4);
    });

    it("never reads the private key from LAWHA_BACKUP_RECIPIENT, an env var, or anywhere but the path/stdin it was given", () => {
      // The one invariant this whole task exists to protect: nothing about
      // decrypting a backup may come from the environment a server container
      // would also see. Setting a plausible-looking env var and confirming it
      // is never consulted is the negative-space proof that --identity/stdin
      // are truly the only two doors in.
      const keyDir = scratch("keys");
      const { backup, identityFile } = takeEncryptedBackup(1, keyDir);
      const target = scratch("target");
      const dbPath = path.join(target, "lawha.db");

      const result = run("restore.mjs", [backup, "--identity", identityFile], {
        LAWHA_DB_PATH: dbPath,
        // Real-shaped but WRONG values: if any of these were ever read,
        // decryption would fail against it instead of succeeding with the
        // (correct) --identity file.
        //
        // `LAWHA_DB_KEY` used to be one of the decoys here and is deliberately
        // NOT any more. It is a real setting now — the SQLCipher key for the
        // live database (Task 6) — and this script reads it, so leaving it in
        // this list would be asserting the opposite of what the list means.
        // The three below are names that plausibly LOOK like somewhere an age
        // identity might be smuggled in from, and none of them is ever read.
        LAWHA_BACKUP_RECIPIENT: "age1" + "q".repeat(58),
        LAWHA_BACKUP_IDENTITY: "AGE-SECRET-KEY-1" + "Q".repeat(43),
        LAWHA_AGE_IDENTITY: "AGE-SECRET-KEY-1" + "Q".repeat(43),
        AGE_IDENTITY: "AGE-SECRET-KEY-1" + "Q".repeat(43),
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(countsOf(dbPath).users, 1);
    });

    it("refuses clearly when no private key is given at all", () => {
      const keyDir = scratch("keys");
      const { backup } = takeEncryptedBackup(1, keyDir);
      const target = scratch("target");
      const dbPath = path.join(target, "lawha.db");

      // `run()` uses spawnSync with no `input`, which closes the child's
      // stdin immediately — the same "nothing was piped" shape an operator
      // gets from forgetting the key, not a hang.
      const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /needs the private key/);
      assert.ok(!fs.existsSync(dbPath), "nothing should have been installed");
    });

    it("refuses clearly, and touches nothing, when the identity is the wrong key", () => {
      const keyDir = scratch("keys");
      const { backup } = takeEncryptedBackup(1, keyDir);
      // A real, unrelated identity — proves the failure is "wrong key", not
      // "malformed file".
      const { identityFile: wrongIdentity } = generateAgeKeypair(
        scratch("other-keys"),
      );

      const target = scratch("target");
      const { dbPath, db } = createLiveDatabase(target, { users: 9 });
      db.close();

      const result = run("restore.mjs", [backup, "--identity", wrongIdentity], {
        LAWHA_DB_PATH: dbPath,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not decrypt/);
      // Nothing about the live database was ever touched — decrypt happens
      // and fails before the move-aside step is reached.
      assert.deepEqual(asideIn(target), []);
      assert.equal(countsOf(dbPath).users, 9);
    });

    it("a plaintext backup restores exactly as before, even with --identity given", () => {
      // "Opt-in is absolute" from the decrypt side: a backup that was never
      // encrypted must not go anywhere near `age`, whether or not the
      // operator happens to pass a key. `looksEncrypted()` is what has to get
      // this right — it must never treat a plain database as ciphertext.
      const keyDir = scratch("keys");
      const { identityFile } = generateAgeKeypair(keyDir);
      const backup = takeBackup(5);
      const target = scratch("target");
      const dbPath = path.join(target, "lawha.db");

      const result = run("restore.mjs", [backup, "--identity", identityFile], {
        LAWHA_DB_PATH: dbPath,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /decrypting/);
      assert.equal(countsOf(dbPath).users, 5);
    });
  },
);

describe("restore.mjs — decrypting a backup that is not really age ciphertext", () => {
  // Does not need the real binary: a `stageAgeArtifact` file has the right
  // magic header (so `looksEncrypted()` says yes) but is not something any
  // `age` build can decrypt, real or fake — good enough to prove the failure
  // path is reached and reported, without needing a real key pair.
  it("fails clearly instead of installing garbage", () => {
    const archive = scratch("archive");
    const backup = stageAgeArtifact(archive, "lawha-19700101-000000.db.age");
    const identityFile = path.join(archive, "identity.txt");
    fs.writeFileSync(
      identityFile,
      "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n",
    );

    const target = scratch("target");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup, "--identity", identityFile], {
      LAWHA_DB_PATH: dbPath,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not decrypt/);
    assert.ok(!fs.existsSync(dbPath));
  });
});

describe("restore.mjs — interrupted while age is still running", () => {
  // The bug class named in this task's brief, checked for real: a signal
  // landing during the decrypt `await` must never leave the live database
  // touched, because at this point in the sequence nothing about it has been
  // moved yet — the whole point of decrypting BEFORE the move-aside step, not
  // after it. Not gated behind `ageAvailable`: the stand-in age never runs
  // real cryptography, so this has nothing to do with whether the real binary
  // is installed, same reasoning `backup.test.mjs`'s equivalent test gives.
  it("a signal during decryption touches nothing about the live database", async () => {
    const archive = scratch("archive");
    const backup = stageAgeArtifact(archive, "lawha-19700101-000000.db.age");
    const identityFile = path.join(archive, "identity.txt");
    fs.writeFileSync(identityFile, "not read by the stand-in age\n");

    const target = scratch("target");
    const { dbPath, db } = createLiveDatabase(target, { users: 6, boards: 1 });
    db.close();
    const originalBytes = fs.readFileSync(dbPath);

    const result = await runAndInterruptWhileAgeRuns(
      "restore.mjs",
      [backup, "--identity", identityFile],
      { LAWHA_DB_PATH: dbPath },
      { workDir: scratch("work") },
    );

    assert.ok(
      result.status === 143 || result.signal === "SIGTERM",
      `expected an interrupted run, got status ${result.status} / signal ` +
        `${result.signal}: ${result.stdout}${result.stderr}`,
    );

    // Asserted on BYTES, not on a filename existing or not — the exact
    // instruction this task's brief gives, and the exact class of bug Task 3
    // shipped once: a tracking variable cleared (or, here, never set) before
    // the thing it describes actually happened is only caught by reading what
    // is really on disk.
    assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
    assert.deepEqual(asideIn(target), []);
    assert.match(result.stderr, /nothing was changed/);
  });
});

describe("restore.mjs — restoring blobs", () => {
  const populate = (dir, relative, content) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  it("copies plaintext blobs into place, preserving their layout", () => {
    const backup = takeBackup(1);
    const target = scratch("target");
    const dbPath = path.join(target, "lawha.db");
    const mirror = scratch("mirror");
    populate(mirror, "rooms/abc123/def456", "a real image, honest");
    populate(mirror, "shareLinks/xyz/blob", "another one");

    const result = run("restore.mjs", [backup, "--files", mirror], {
      LAWHA_DB_PATH: dbPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(target, "files", "rooms", "abc123", "def456"),
        "utf8",
      ),
      "a real image, honest",
    );
    assert.equal(
      fs.readFileSync(
        path.join(target, "files", "shareLinks", "xyz", "blob"),
        "utf8",
      ),
      "another one",
    );
  });

  it("says how to restore blobs properly, and does not suggest a plain cp -a, when --files is not given", () => {
    const backup = takeBackup(1);
    const target = scratch("target");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NOT restored/);
    assert.match(result.stdout, /--files/);
    // The old advice, which corrupts an images directory once any blob in the
    // mirror is `.age` ciphertext, must not survive as the ONLY suggestion.
    assert.doesNotMatch(result.stdout, /restore them with cp -a/);
  });

  describe(
    "encrypted blobs",
    { skip: !ageAvailable && "age is not on PATH in this environment" },
    () => {
      it("decrypts .age blobs and copies plaintext ones alongside them", () => {
        const keyDir = scratch("keys");
        const { recipient, identityFile } = generateAgeKeypair(keyDir);
        const backup = takeBackup(1);
        const target = scratch("target");
        const dbPath = path.join(target, "lawha.db");
        const mirror = scratch("mirror");

        const plain = populate(mirror, "rooms/a/plain", "never touched");

        const encryptSource = populate(
          mirror,
          "rooms/a/secret.tmp",
          "a real blob",
        );
        const encrypted = spawnSync("age", [
          "-r",
          recipient,
          "-o",
          path.join(mirror, "rooms", "a", "secret.age"),
          encryptSource,
        ]);
        assert.equal(encrypted.status, 0, encrypted.stderr?.toString("utf8"));
        fs.unlinkSync(encryptSource);

        const result = run(
          "restore.mjs",
          [backup, "--files", mirror, "--identity", identityFile],
          { LAWHA_DB_PATH: dbPath },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          fs.readFileSync(
            path.join(target, "files", "rooms", "a", "plain"),
            "utf8",
          ),
          "never touched",
        );
        assert.equal(
          fs.readFileSync(
            path.join(target, "files", "rooms", "a", "secret"),
            "utf8",
          ),
          "a real blob",
        );
        assert.ok(
          !fs.existsSync(
            path.join(target, "files", "rooms", "a", "secret.age"),
          ),
          "the ciphertext name must not survive into the live files directory",
        );
        assert.equal(plain, path.join(mirror, "rooms", "a", "plain"));
      });

      it("refuses before touching the live database when blobs need a key nobody gave it", () => {
        const keyDir = scratch("keys");
        const { recipient } = generateAgeKeypair(keyDir);
        const backup = takeBackup(1);
        const target = scratch("target");
        const { dbPath, db } = createLiveDatabase(target, { users: 4 });
        db.close();
        const mirror = scratch("mirror");

        const encryptSource = populate(
          mirror,
          "rooms/a/secret.tmp",
          "a real blob",
        );
        const encrypted = spawnSync("age", [
          "-r",
          recipient,
          "-o",
          path.join(mirror, "rooms", "a", "secret.age"),
          encryptSource,
        ]);
        assert.equal(encrypted.status, 0, encrypted.stderr?.toString("utf8"));
        fs.unlinkSync(encryptSource);

        // No --identity, and spawnSync's closed stdin gives an immediate,
        // deterministic "nothing was piped" rather than a hang.
        const result = run("restore.mjs", [backup, "--files", mirror], {
          LAWHA_DB_PATH: dbPath,
        });

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /needs the private key/);
        // The whole point of checking this BEFORE the move-aside step: the
        // live database — which the plaintext backup above could otherwise
        // have overwritten just fine — is untouched because the blobs half
        // of the same invocation could not have finished.
        assert.deepEqual(asideIn(target), []);
        assert.equal(countsOf(dbPath).users, 4);
      });

      /**
       * Review's own finding: `identityNeeded` proves a key was SUPPLIED,
       * not that it opens every blob — a mirror can hold blobs encrypted to
       * more than one recipient over a deployment's life (a rotated key, a
       * blob mirrored before the current recipient existed). Before this
       * fix, a per-blob decrypt failure here rejected out of an unwrapped
       * `await`, crashing with an unhandled rejection instead of the
       * message the rest of this file's comments already claimed to print.
       */
      it("reports progress and stops cleanly when one blob in the mirror needs a DIFFERENT key", () => {
        const keyDir = scratch("keys");
        const { recipient, identityFile } = generateAgeKeypair(keyDir);
        // A second, unrelated keypair — its recipient is what this blob is
        // encrypted to, so OUR identity above cannot open it.
        const { recipient: otherRecipient } = generateAgeKeypair(
          scratch("other-keys"),
        );
        const backup = takeBackup(1);
        const target = scratch("target");
        const dbPath = path.join(target, "lawha.db");
        const mirror = scratch("mirror");

        // Alphabetically first, so it is restored before the bad one below —
        // proving "1 of 2" rather than "0 of 2" in the message.
        const goodSource = populate(mirror, "rooms/a-good.tmp", "a real blob");
        const goodEncrypted = spawnSync("age", [
          "-r",
          recipient,
          "-o",
          path.join(mirror, "rooms", "a-good.age"),
          goodSource,
        ]);
        assert.equal(
          goodEncrypted.status,
          0,
          goodEncrypted.stderr?.toString("utf8"),
        );
        fs.unlinkSync(goodSource);

        const badSource = populate(
          mirror,
          "rooms/b-wrong-key.tmp",
          "nobody with our key can read this",
        );
        const badEncrypted = spawnSync("age", [
          "-r",
          otherRecipient,
          "-o",
          path.join(mirror, "rooms", "b-wrong-key.age"),
          badSource,
        ]);
        assert.equal(
          badEncrypted.status,
          0,
          badEncrypted.stderr?.toString("utf8"),
        );
        fs.unlinkSync(badSource);

        const result = run(
          "restore.mjs",
          [backup, "--files", mirror, "--identity", identityFile],
          { LAWHA_DB_PATH: dbPath },
        );

        assert.notEqual(result.status, 0);
        // The database restore, which finished before blobs even started,
        // is unaffected — reported, not silently dropped.
        assert.match(
          result.stderr,
          /the database above was already restored and verified/,
        );
        assert.match(result.stderr, /1 of 2 blob\(s\) restored/);
        assert.match(result.stderr, /b-wrong-key\.age/);
        // Never an unhandled-rejection trace — a controlled, single failure.
        assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection/);
        // The one blob that COULD be opened landed; the target directory
        // proves this independently of the message.
        assert.equal(
          fs.readFileSync(
            path.join(target, "files", "rooms", "a-good"),
            "utf8",
          ),
          "a real blob",
        );
        assert.equal(countsOf(dbPath).users, 1);
      });
    },
  );
});

describe("restore.mjs — a failed install", () => {
  /**
   * Review's own finding: an I/O error between the move-aside and the
   * install had no `try` and no `uncaughtException` handler, so it exited
   * with a raw V8 stack trace instead of the recovery sentence this file
   * already wrote for exactly this state. `ENOTDIR` — an intermediate path
   * segment that turns out to be a plain file — is used here because it is
   * fully deterministic (no permission gymnastics, no race against a
   * chmod), unlike the disk-full/permission-denied failures this same
   * `catch` is written for; the `catch` itself does not care which one
   * produced the error, so this is a faithful stand-in for both.
   */
  it("prints the recovery sentence instead of a raw stack trace when the install fails", () => {
    const backup = takeBackup(1);
    const target = scratch("target");
    // `blocker` is a FILE. `<blocker>/nested/lawha.db` can never be created
    // under it — mkdir fails with ENOTDIR, deterministically, every time.
    fs.writeFileSync(path.join(target, "blocker"), "not a directory");
    const dbPath = path.join(target, "blocker", "nested", "lawha.db");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not install the restored database/);
    assert.match(result.stderr, /ENOTDIR/);
    // The one thing this test exists to prove was NOT happening before the
    // fix: a clean, single, actionable failure — not a second, unrelated
    // crash from the exit-handler's own cleanup trying to remove a scratch
    // file whose path is itself invalid for the same ENOTDIR reason.
    assert.doesNotMatch(result.stderr, /at Object\.rmSync/);
    assert.doesNotMatch(result.stderr, /internal\/(fs|process)/);
  });

  it("says nothing was lost when there was no existing database to protect", () => {
    const backup = takeBackup(1);
    const target = scratch("target");
    fs.writeFileSync(path.join(target, "blocker"), "not a directory");
    const dbPath = path.join(target, "blocker", "nested", "lawha.db");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing existed at .* so nothing was lost/);
  });

  /**
   * The `hadDatabase === true` branch of the install-failure message (the
   * "your data is safe at `<aside>`" one) cannot be forced through
   * execution in this black-box suite: `dbPath` and `aside` share one
   * directory, so any permission/ENOTDIR trick that blocks the install also
   * blocks the move-aside a moment earlier, which is a DIFFERENT,
   * already-correct, unguarded code path — hitting it here would prove
   * nothing about the catch this test exists to cover. Covered instead by
   * `asideRecoveryAdvice()`'s own call-count check below, which would drop
   * from 2 to 1 if this ternary's `hadDatabase` branch were ever deleted —
   * verified by mutation in the task report, not asserted blindly here.
   */
  it("shares its recovery sentence with the signal handler rather than keeping a second copy", () => {
    const source = fs.readFileSync(
      path.join(SCRIPTS_DIR, "restore.mjs"),
      "utf8",
    );
    assert.match(
      source,
      /hadDatabase\s*\n\s*\?\s*`lawha: \$\{asideRecoveryAdvice\(\)\}`/,
    );
  });
});

/**
 * Two safety properties that no behavioural test above can force through
 * execution, checked instead on the script's own source — the same
 * "extract, assert on literals" technique `backupCoverage.test.ts` used for
 * `docker/lawha-backup.sh` before it was removed (`59930dbf`) — this file is
 * where the technique still lives.
 *
 * `fs.copyFileSync` is not atomic, so a test cannot make an interrupt land
 * mid-copy on demand without controlling exact byte counts and OS scheduling
 * — not something worth chasing when the fix is a structural one: never let
 * `dbPath` be the direct target of a copy. Pinning that shape here is what
 * stands in for an execution test this codebase cannot reliably write.
 */
describe("restore.mjs — structural safety invariants", () => {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, "restore.mjs"), "utf8");

  it("never copies straight onto dbPath — only onto a staging name, then renames", () => {
    assert.doesNotMatch(
      source,
      /fs\.copyFileSync\(\s*verifyTarget\s*,\s*dbPath\s*\)/,
      "a direct copy onto dbPath can be interrupted mid-write, leaving a " +
        "half-written file wearing the live database's own name",
    );
    assert.match(source, /fs\.copyFileSync\(verifyTarget, installingTmp\)/);
    assert.match(source, /fs\.renameSync\(installingTmp, dbPath\)/);
    // Order matters: the copy has to land before the rename that publishes it.
    assert.ok(
      source.indexOf("fs.copyFileSync(verifyTarget, installingTmp)") <
        source.indexOf("fs.renameSync(installingTmp, dbPath)"),
    );
  });

  it("decrypts before the live database is ever touched, not after", () => {
    const decryptCall = source.indexOf("await decryptWithIdentity(");
    const moveAside = source.indexOf("fs.renameSync(dbPath, aside)");
    assert.ok(decryptCall > 0 && moveAside > 0);
    assert.ok(
      decryptCall < moveAside,
      "decrypt must happen before anything about the live database moves — " +
        "see the header comment's SIGNAL HANDLING section for why",
    );
  });

  it("registers signal handlers for the same three signals backup.mjs does", () => {
    assert.match(
      source,
      /const INTERRUPTS = \{ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 \};/,
    );
    assert.match(source, /process\.on\(signal, \(\) => \{/);
  });

  it("tracks restorePhase right where it changes, not somewhere it could drift from the truth", () => {
    // The fully-synchronous move-aside-then-install window cannot be forced
    // to interrupt on demand in a test (see this describe block's own header
    // comment) — this is the textual half of covering it: the transition
    // must sit immediately beside the operation it describes, so the two
    // cannot silently fall out of sync.
    assert.match(
      source,
      /fs\.renameSync\(dbPath, aside\);\s*\n\s*restorePhase = "moved-aside";/,
    );
    // "installed" now sits after the try/catch around the install (see the
    // review round that added it, below) rather than on the very next line —
    // still inside the same statement run, with nothing that can yield
    // between the rename and this assignment.
    assert.match(
      source,
      /fs\.renameSync\(installingTmp, dbPath\);\s*\n\}\s*catch[\s\S]{0,400}?\n\s*\nrestorePhase = "installed";/,
    );
    // And the handler must actually read it back, in both non-default branches.
    assert.match(source, /restorePhase === "moved-aside"/);
    assert.match(source, /restorePhase === "installed"/);
  });

  it("wraps the install in a try, and reuses the signal handler's own recovery sentence", () => {
    // Review found this failure reachable and unhandled: an I/O error
    // between the move-aside and the install (a full disk, a permissions
    // problem) had no `try` above it and no `uncaughtException` handler, so
    // it surfaced as a raw V8 stack trace with `lawha.db` simply gone — while
    // the recovery sentence written for exactly this state was wired only to
    // a signal branch that can never fire in this fully-synchronous window.
    const installTry = source.indexOf(
      "try {\n  fs.mkdirSync(path.dirname(dbPath), { recursive: true });\n  " +
        "fs.copyFileSync(verifyTarget, installingTmp);\n  " +
        "fs.renameSync(installingTmp, dbPath);\n}",
    );
    assert.ok(installTry > 0, "the install is not wrapped in its own try");

    // One function, read from both the signal handler and the catch block —
    // not two copies of the same sentence that could drift apart again.
    // Matched as an actual call (`${asideRecoveryAdvice()}`), not merely the
    // bare name, which also appears twice more in prose comments explaining
    // the sharing and would otherwise inflate this count.
    const adviceDefinitions = source.match(/const asideRecoveryAdvice = /g);
    assert.equal(
      adviceDefinitions?.length,
      1,
      "asideRecoveryAdvice must be defined exactly once",
    );
    const adviceCalls = source.match(/\$\{asideRecoveryAdvice\(\)\}/g);
    assert.equal(
      adviceCalls?.length,
      2,
      "asideRecoveryAdvice() must be called from both the signal handler " +
        "and the install's own catch block",
    );
  });

  it("checks stdin.isTTY before reading a key, so the documented bare invocation cannot hang forever", () => {
    // The documented invocation is `restore <file>` with no
    // --identity. Without this check, a real terminal with nothing piped
    // blocks on fs.readFileSync(0) waiting for an EOF nobody will ever send
    // — verified against a real pty, not just this test suite's spawnSync,
    // which pre-closes stdin and so never reaches this branch at all.
    assert.match(source, /process\.stdin\.isTTY/);
    // The actual assignment, not the comment above it that also mentions the
    // call in prose (and would otherwise make this look backwards).
    assert.ok(
      source.indexOf("if (process.stdin.isTTY)") <
        source.indexOf('material = fs.readFileSync(0, "utf8")'),
      "the TTY check must run before the blocking read, not after",
    );
  });

  it("wraps the blob restore in a try, reporting progress rather than a bare rejection", () => {
    // A blob-decrypt failure after the database is already installed used to
    // reject out of an unwrapped `await`, crashing with an unhandled
    // rejection instead of the message this file's own comments claim to
    // print. `identityNeeded` only proves a key was SUPPLIED, not that it
    // opens every blob a mixed-recipient mirror might hold.
    assert.match(source, /await restoreBlobs\(/);
    const restoreBlobsCallIndex = source.indexOf("await restoreBlobs(");
    const precedingTry = source.lastIndexOf("try {", restoreBlobsCallIndex);
    const precedingCatch = source.indexOf("} catch", restoreBlobsCallIndex);
    assert.ok(
      precedingTry > 0 && precedingTry < restoreBlobsCallIndex,
      "await restoreBlobs(...) must sit inside a try",
    );
    assert.ok(
      precedingCatch > restoreBlobsCallIndex,
      "the try around restoreBlobs must have its own catch",
    );
    assert.match(source, /of \$\{files\.length\} blob\(s\) restored/);
  });

  it("reads LAWHA_FILES_DIR for the blob restore destination, matching backup.mjs's own convention", () => {
    assert.match(source, /process\.env\.LAWHA_FILES_DIR/);
  });
});

/**
 * `LAWHA_DB_KEY` — restoring into, and out of, a SQLCipher deployment
 * (Task 7B).
 *
 * A backup taken from a keyed database is itself SQLCipher ciphertext, so
 * "install it" is a plain file copy and the interesting questions are all
 * about REFUSING: the wrong key, no key, and a plaintext artefact aimed at a
 * deployment that has opted in. Every refusal below is checked to have left
 * the existing database exactly where it was, because a restore that half-runs
 * is the failure this whole script is shaped around.
 *
 * Note what the environment actually looks like on restore day: `LAWHA_DB_KEY`
 * lives in `lawha.env`, which only ever reaches the containers. A restore runs
 * on the HOST, so the key is absent unless the operator exports it — which
 * makes "encrypted artefact, no key" the single most reachable mistake here,
 * not an exotic one.
 */
describe("restore.mjs — with LAWHA_DB_KEY set", () => {
  const KEY = "correct-horse-battery-staple";
  const WRONG_KEY = "wrong-horse-battery-staple-98";

  /** A verified, SQLCipher-encrypted backup holding `users` accounts. */
  const takeKeyedBackup = (users) => {
    const dataDir = scratch("source");
    const outDir = scratch("archive");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users,
      boards: 2,
    });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    const [name] = backupsIn(outDir);
    assert.ok(name, `no backup written: ${result.stdout}${result.stderr}`);
    return path.join(outDir, name);
  };

  it("installs a database the server can open with the same key", () => {
    const backup = takeKeyedBackup(3);
    const target = scratch("live");
    const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
      users: 9,
    });
    db.close();

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !readsAsPlaintextSqlite(dbPath),
      "the restored database is plaintext — a keyed deployment just had its " +
        "boards written to disk in the clear",
    );
    assert.deepEqual(encryptedCountsOf(dbPath, KEY), {
      users: 3,
      boards: 2,
      board_scenes: 0,
      files: 0,
    });
    // And the displaced original is still there, still readable, still keyed.
    const [kept] = asideIn(target);
    assert.ok(kept, "the existing database was not kept aside");
    assert.equal(encryptedCountsOf(path.join(target, kept), KEY).users, 9);
  });

  it("refuses the wrong key and leaves the original exactly where it was", () => {
    const backup = takeKeyedBackup(1);
    const target = scratch("live");
    const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
      users: 9,
    });
    db.close();
    const before = fs.readFileSync(dbPath);

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: WRONG_KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAWHA_DB_KEY/);
    assert.deepEqual(asideIn(target), [], "nothing should have been moved");
    // On the BYTES, not on the name: a file still called `lawha.db` that is
    // no longer the same file is the failure a name check cannot see.
    assert.ok(
      before.equals(fs.readFileSync(dbPath)),
      "the live database was modified by a restore that refused",
    );
  });

  it("says what is wrong when the artefact is encrypted and no key was given", () => {
    const backup = takeKeyedBackup(1);
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup], { LAWHA_DB_PATH: dbPath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAWHA_DB_KEY/);
    assert.ok(!fs.existsSync(dbPath), "nothing should have been installed");
  });

  it("refuses a plaintext backup into a keyed deployment, and names the way out", () => {
    // Installing it would produce a database the server refuses to boot
    // against ("LAWHA_DB_KEY is set, but this file is NOT encrypted" —
    // src/db/index.ts), discovered on the next `docker compose up` rather
    // than here. `encrypt-db` is the tool that already does this conversion
    // safely, so the message points at it rather than a second copy of it
    // growing inside this script.
    const dataDir = scratch("source");
    const outDir = scratch("archive");
    const { dbPath: sourcePath, db: sourceDb } = createLiveDatabase(dataDir, {
      users: 2,
    });
    assert.equal(
      run("backup.mjs", [outDir], { LAWHA_DB_PATH: sourcePath }).status,
      0,
    );
    sourceDb.close();
    const backup = path.join(outDir, backupsIn(outDir)[0]);

    const target = scratch("live");
    const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
      users: 9,
    });
    db.close();

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /encrypt-db/);
    assert.deepEqual(asideIn(target), []);
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 9);
  });

  it("refuses a key the server itself would not boot with", () => {
    const backup = takeKeyedBackup(1);
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "123456789012345",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16|under 16|16 characters/);
    assert.ok(!fs.existsSync(dbPath));
  });

  it("still refuses while a server holds the encrypted database open", () => {
    // `claimExclusively` opens the LIVE file, so it had to learn the key too
    // — with the plain driver it would report an encrypted database as "in
    // use" whether or not anything was running, which is a true refusal for
    // the wrong reason and sends the operator to --force.
    const backup = takeKeyedBackup(1);
    const target = scratch("live");
    const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
      users: 9,
    });

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /in use/);
    assert.deepEqual(asideIn(target), []);
  });

  it("restores into an empty spot, which is what a fresh machine looks like", () => {
    const backup = takeKeyedBackup(4);
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!readsAsPlaintextSqlite(dbPath));
    assert.equal(encryptedCountsOf(dbPath, KEY).users, 4);
  });
});

/**
 * The recovery path must survive the cipher driver being absent — see the
 * long comment on the matching suite in `backup.test.mjs` for the live
 * incident, and `stageWithoutCipherDriver` for how the container's layout is
 * reproduced.
 *
 * It matters MORE here than it does there. A backup that fails is a gap in an
 * archive somebody notices next cycle; a restore that fails is somebody
 * holding a good backup and no way to install it, on the worst day of their
 * deployment's life. Both files carried the same defect and both lost it at
 * the same instant.
 */
describe("restore.mjs — with the cipher driver absent from resolution", () => {
  it("installs an unkeyed backup, and verifies what landed", () => {
    const backup = takeBackup(3);
    const isolated = scratch("container");
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");
    const scriptsDir = stageWithoutCipherDriver(isolated, ["restore.mjs"]);

    const result = runAt(path.join(scriptsDir, "restore.mjs"), [backup], {
      LAWHA_DB_PATH: dbPath,
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(countsOf(dbPath).users, 3);
  });

  it("still prints its usage, which is what a failure at module load destroys", () => {
    const isolated = scratch("container");
    const scriptsDir = stageWithoutCipherDriver(isolated, ["restore.mjs"]);

    const result = runAt(path.join(scriptsDir, "restore.mjs"), ["--help"], {});

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /usage: /);
  });

  it("refuses a KEYED run there by name, and says which command fixes it", () => {
    const backup = takeBackup(1);
    const isolated = scratch("container");
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");
    const scriptsDir = stageWithoutCipherDriver(isolated, ["restore.mjs"]);

    const result = runAt(path.join(scriptsDir, "restore.mjs"), [backup], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "correct-horse-battery-staple",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker compose build/);
    assert.doesNotMatch(result.stderr, /^\s+at /m);
    assert.ok(!fs.existsSync(dbPath), "nothing should have been installed");
  });
});

/**
 * Two refusals that were right about the failure and wrong about the words —
 * both found in review, both about sending an operator somewhere useless at
 * the moment they can least afford it.
 */
describe("restore.mjs — refusals that have to be actionable", () => {
  const KEY = "correct-horse-battery-staple";

  it("names the backup the operator gave, not the temp file it was decrypted into", () => {
    // An `age`-wrapped artefact is decrypted to `os.tmpdir()` and verified
    // from there, and the exit handler deletes that copy. Naming it in the
    // failure points at a path that is already gone, about a file that is
    // not — so the one thing the operator can actually go and look at never
    // appears. Reproduced here without `age` at all: a file that merely
    // LOOKS like age ciphertext takes the same branch.
    const dir = scratch("archive");
    const backup = stageAgeArtifact(dir, "lawha-20260101-000000.db.age");
    const identity = path.join(dir, "identity.txt");
    fs.writeFileSync(identity, "AGE-SECRET-KEY-1NOTAREALKEY");
    const target = scratch("live");
    const dbPath = path.join(target, "lawha.db");

    const result = run("restore.mjs", [backup, "--identity", identity], {
      LAWHA_DB_PATH: dbPath,
    });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stderr,
      /lawha-restore-decrypted-/,
      "the failure names a temp file this process deletes on the way out",
    );
  });

  it("prints a recovery recipe that carries the flags this run was given", () => {
    // The plaintext-artefact refusal spells out two commands to run instead.
    // Without `--identity`, the first of them cannot decrypt the artefact it
    // names — a recipe that fails when pasted is worse than none, because the
    // next thing doubted is the backup.
    const dataDir = scratch("source");
    const outDir = scratch("archive");
    const { dbPath: sourcePath, db: sourceDb } = createLiveDatabase(dataDir, {
      users: 1,
    });
    assert.equal(
      run("backup.mjs", [outDir], { LAWHA_DB_PATH: sourcePath }).status,
      0,
    );
    sourceDb.close();
    const backup = path.join(outDir, backupsIn(outDir)[0]);

    const blobs = scratch("blobs");
    const identity = path.join(scratch("keys"), "identity.txt");
    fs.writeFileSync(identity, "AGE-SECRET-KEY-1NOTAREALKEY");

    const target = scratch("live");
    const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
      users: 9,
    });
    db.close();

    const result = run(
      "restore.mjs",
      [backup, "--identity", identity, "--files", blobs],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /encrypt-db/);
    assert.match(result.stderr, new RegExp(`--identity ${identity}`));
    assert.match(result.stderr, new RegExp(`--files ${blobs}`));
  });
});

/**
 * The round trip with BOTH halves on — the state a deployment that opted into
 * everything is actually in, and the one no test in this repository covered.
 *
 * `backup.test.mjs` proves the artefact nests correctly; this proves the
 * artefact is USABLE, which is a different claim and the one that matters on
 * restore day. The two keys arrive by deliberately different doors and that is
 * the whole design: the `age` identity as `--identity` or on stdin and never
 * from the environment, `LAWHA_DB_KEY` from the environment because the server
 * needs it there anyway.
 */
describe(
  "restore.mjs — LAWHA_DB_KEY and an age-wrapped artefact together",
  { skip: !ageAvailable && "age is not on PATH in this environment" },
  () => {
    const KEY = "correct-horse-battery-staple";
    const WRONG_KEY = "wrong-horse-battery-staple-98";

    /** A backup with both halves applied, and the identity that unwraps it. */
    const takeDoublyEncryptedBackup = (users) => {
      const dataDir = scratch("source");
      const outDir = scratch("archive");
      const keyDir = scratch("keys");
      const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
        users,
        boards: 2,
      });
      const { recipient, identityFile } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.equal(result.status, 0, result.stderr);
      const [name] = fs
        .readdirSync(outDir)
        .filter((entry) => entry.endsWith(".db.age"));
      assert.ok(name, `no .db.age written: ${result.stdout}${result.stderr}`);

      return { backup: path.join(outDir, name), identityFile };
    };

    it("unwraps age, then installs a database the server opens with the key", () => {
      const { backup, identityFile } = takeDoublyEncryptedBackup(3);
      const target = scratch("live");
      const dbPath = path.join(target, "lawha.db");

      const result = run("restore.mjs", [backup, "--identity", identityFile], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /decrypting/);
      assert.ok(
        !readsAsPlaintextSqlite(dbPath),
        "the restored database is plaintext — unwrapping age wrote the " +
          "database out in the clear instead of installing the ciphertext " +
          "that was inside it",
      );
      assert.deepEqual(encryptedCountsOf(dbPath, KEY), {
        users: 3,
        boards: 2,
        board_scenes: 0,
        files: 0,
      });
    });

    it("takes the age identity from stdin while the database key comes from the environment", () => {
      // The two doors, exercised at once. This is the invariant the whole of
      // Half A rests on: the age private key never arrives through anything a
      // server container can also see, while LAWHA_DB_KEY does exactly that.
      const { backup, identityFile } = takeDoublyEncryptedBackup(5);
      const target = scratch("live");
      const dbPath = path.join(target, "lawha.db");

      const result = runWithStdin(
        "restore.mjs",
        [backup],
        fs.readFileSync(identityFile, "utf8"),
        { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(encryptedCountsOf(dbPath, KEY).users, 5);
    });

    it("refuses the wrong database key AFTER a successful age decrypt, leaving the original", () => {
      // The one ordering worth pinning here: the age layer comes off fine, so
      // the refusal has to come from reading the database underneath it. A
      // run that stopped checking once `age` succeeded would install
      // ciphertext nothing can open, over a database that was fine.
      const { backup, identityFile } = takeDoublyEncryptedBackup(1);
      const target = scratch("live");
      const { dbPath, db } = createEncryptedLiveDatabase(target, KEY, {
        users: 9,
      });
      db.close();
      const before = fs.readFileSync(dbPath);

      const result = run("restore.mjs", [backup, "--identity", identityFile], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: WRONG_KEY,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /decrypting/);
      assert.match(result.stderr, /LAWHA_DB_KEY/);
      assert.deepEqual(asideIn(target), [], "nothing should have been moved");
      assert.ok(
        before.equals(fs.readFileSync(dbPath)),
        "the live database was modified by a restore that refused",
      );
    });
  },
);
