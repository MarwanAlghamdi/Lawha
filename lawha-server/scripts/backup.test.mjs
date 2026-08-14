import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import {
  SCRIPTS_DIR,
  backupsIn,
  countsOf,
  createBulkyDatabase,
  createBulkyEncryptedDatabase,
  createEncryptedLiveDatabase,
  createLiveDatabase,
  encryptedCountsOf,
  makeTempDir,
  openEncrypted,
  readsAsPlaintextSqlite,
  run,
  runAndInterrupt,
  runAndInterruptWhen,
  runAt,
  runPipedToHead,
  stageVerifiedBackup,
  stageWithoutCipherDriver,
  tableNames,
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

/**
 * `age` and `age-keygen` are needed only by the tests below that actually
 * encrypt and decrypt for real. Not installed on this dev machine (Task 1
 * confirmed `age --version` -> ENOENT); packaged into the Docker image by
 * Task 2. Detected once, synchronously — `describe` bodies all run before any
 * `it` does, so this has to be known before the first `describe.skip` below
 * is even reached, with nothing async available to wait on at that point.
 */
const ageAvailable = spawnSync("age", ["--version"]).status === 0;

if (!ageAvailable) {
  process.stderr.write(
    "\n!!! backup.mjs age round-trip tests DID NOT RUN !!!\n" +
      "    `age` is not on PATH in this environment.\n" +
      "    Nothing below encrypted or decrypted anything for real.\n\n",
  );
}

/**
 * A real key pair, minted by `age-keygen` itself — not a fixture string —
 * because the round-trip test below exists to prove `backup.mjs` produces
 * something `age -d` can actually open, not merely something that looks
 * like ciphertext. Mirrors the fixture in
 * `tests/integration/ageEncrypt.test.ts`.
 */
const generateAgeKeypair = (dir) => {
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
 * Mirrors `AGE_MAGIC` in `backup.mjs` — duplicated rather than imported,
 * because `backup.mjs` is a script with no exports, not a module. Standing in
 * for "a real, complete encrypted backup" the same way `stageVerifiedBackup`'s
 * SQLite file stands in for one, so the retention tests below can pin
 * "counts and prunes `.age` files" without needing the real `age` binary,
 * which that behaviour has nothing to do with.
 */
const AGE_MAGIC = "age-encryption.org/v1";

const stageAgeArtifact = (dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `${AGE_MAGIC}\nstand-in ciphertext, not real age output\n`,
  );
  return file;
};

/** A file with a backup's name that is not, in fact, a readable backup. */
const stageUnreadableAgeArtifact = (dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "not an age file at all");
  return file;
};

/** `BACKUP_NAME` and `AGE_BACKUP_NAME` in `backup.mjs`, combined. */
const ANY_BACKUP_NAME = /^lawha-\d{8}-\d{6}\.db(\.age)?$/;

/**
 * A syntactically valid recipient with no real key behind it — good enough
 * for the interrupt tests below, which use a fake `age` (see
 * `writeSlowAgeStandIn`) that never actually inspects the recipient it is
 * given. Mirrors the fixture of the same name in `ageEncrypt.test.ts`.
 */
const FIXTURE_RECIPIENT = `age1${"q".repeat(58)}`;

/**
 * A stand-in for `age` that proves it has started — by creating
 * `startedMarker` — before sleeping far longer than any interrupt test needs
 * to wait, and only then producing output.
 *
 * Deliberately not the real binary, and not gated behind `ageAvailable`: what
 * the two tests below prove is that `backup.mjs` never leaves plaintext on
 * disk if IT is interrupted while its `age` CHILD PROCESS is still running —
 * a fact about process and file lifecycle that has nothing to do with `age`'s
 * own behaviour. Requiring the real binary would make this regression guard
 * silently stop running on every machine that does not have `age` installed,
 * which is exactly backwards for a Critical-severity regression test.
 *
 * The sleep is a safety net, not the mechanism under test: the marker file is
 * what the caller polls for, so the actual wait in a passing run is however
 * long `backup.mjs` takes to reach the point of spawning `age` — milliseconds
 * — never the sleep's full duration.
 */
const writeSlowAgeStandIn = (dir, startedMarker) => {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "age");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `: > ${JSON.stringify(startedMarker)}`,
      "sleep 5",
      // Reached only if the test's signal was somehow never delivered — a
      // real backup.mjs would still treat this as a genuine (if useless)
      // ciphertext rather than hang, so a broken interrupt mechanism fails
      // the test's assertions instead of the whole suite.
      'printf "age-encryption.org/v1\\nnever reached in a passing run\\n"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(script, 0o755);
  return binDir;
};

/**
 * Runs `backup.mjs` with the stand-in `age` above on `PATH` ahead of
 * anything real, waits for it to actually start — not a fixed delay, which
 * would either flake under a loaded machine or pad every run with dead time
 * — then sends `signal`. Same polling shape as `runAndInterrupt` in
 * `testSupport.mjs`, adapted to watch a single marker file rather than "any
 * file appeared in this directory", since the thing to wait for here is the
 * CHILD process starting, not the SQLite copy beginning.
 */
const runAndInterruptDuringEncryption = (args, env, signal = "SIGTERM") =>
  new Promise((resolve) => {
    const workDir = scratch("slow-age");
    const startedMarker = path.join(workDir, "age-started");
    const binDir = writeSlowAgeStandIn(workDir, startedMarker);

    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, "backup.mjs"), ...args],
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

/**
 * No file left behind may be a readable SQLite database — checked on the
 * BYTES, not the filename, because a file named `.rejected` or `.partial`
 * proves nothing about whether it is actually readable. This is the exact
 * assertion that would have caught the Critical regression this pair of
 * tests exists for: before the fix, `reject()` cleared its own bookkeeping
 * before encrypting the quarantine copy, so an interrupt during that
 * encryption left `lawha-<stamp>.db.rejected` on disk with its
 * `SQLite format 3` header intact, while the process reported "nothing was
 * removed".
 */
const assertNoPlaintextSqliteLeftIn = (dir) => {
  const SQLITE_HEADER = "SQLite format 3";
  for (const name of fs.readdirSync(dir)) {
    const header = fs
      .readFileSync(path.join(dir, name))
      .subarray(0, SQLITE_HEADER.length)
      .toString("latin1");
    assert.notEqual(
      header,
      SQLITE_HEADER,
      `${name} is readable as a plaintext SQLite database — it survived an ` +
        "interrupt with a recipient configured",
    );
  }
};

describe("backup.mjs", () => {
  it("captures rows that live in the -wal, which a file copy does not", () => {
    // The regression this script exists for, stated as an experiment rather
    // than as a claim: the same database, copied two ways, one of which comes
    // back empty. The connection stays open throughout, so nothing has
    // checkpointed — exactly the state a running server leaves the file in.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, {
      users: 5,
      boards: 4,
      scenes: 4,
      files: 2,
    });

    const naiveCopy = path.join(outDir, "naive-cp.db");
    fs.copyFileSync(dbPath, naiveCopy);

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(tableNames(naiveCopy), []);

    const [name] = backupsIn(outDir);
    assert.ok(name, `no lawha-*.db written: ${result.stdout}${result.stderr}`);
    assert.deepEqual(countsOf(path.join(outDir, name)), {
      users: 5,
      boards: 4,
      board_scenes: 4,
      files: 2,
    });
  });

  it("writes one file with no -wal or -shm to restore alongside it", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(outDir), backupsIn(outDir));
  });

  it("prints the row counts and says the integrity check passed", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 5, boards: 4 });

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.match(result.stdout, /integrity_check ok/);
    assert.match(result.stdout, /5 {2}users/);
    assert.match(result.stdout, /4 {2}boards/);
  });

  it("refuses a source that is not a Lawha database, and quarantines it", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir);
    db.exec("DROP TABLE users");

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no users table/);
    // Kept, but renamed out of the lawha-*.db namespace so neither retention
    // nor restore will ever treat it as a candidate.
    assert.deepEqual(backupsIn(outDir), []);
    assert.deepEqual(
      fs.readdirSync(outDir).map((name) => name.endsWith(".rejected")),
      [true],
    );
  });

  it("exits non-zero when there is no database at the path", () => {
    const outDir = scratch("out");

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: path.join(outDir, "absent.db"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no database at/);
  });

  it("warns rather than fails when the backup holds no accounts", () => {
    // A brand-new server really is empty, so this cannot be an error — but
    // zero accounts is also what the 4KB-header copy produced, so it is never
    // allowed to pass silently.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 0 });

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no user accounts/);
  });

  it("keeps every backup when --keep is not given", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    for (const name of [
      "lawha-20200101-000000.db",
      "lawha-20200102-000000.db",
    ]) {
      fs.writeFileSync(path.join(outDir, name), "");
    }

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(backupsIn(outDir).length, 3);
  });

  it("--keep N removes the oldest and never the one just written", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const old = ["lawha-20200101-000000.db", "lawha-20200102-000000.db"];
    for (const name of old) {
      // Real backups rather than empty placeholders, because retention now
      // opens every candidate before it will count one — an empty placeholder
      // is precisely the artefact an interrupted backup leaves, and the test
      // below pins that those are neither counted nor deleted. The literal
      // "an older backup" has to be an older backup for this to still mean
      // what it meant.
      stageVerifiedBackup(outDir, name, { users: 4 });
      // A sidecar left by an older backup, or by somebody opening the file:
      // deleting the .db and leaving this behind is how a later restore picks
      // up pages from a database that no longer exists.
      fs.writeFileSync(path.join(outDir, `${name}-wal`), "");
    }

    const result = run("backup.mjs", [outDir, "--keep", "2"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    const remaining = backupsIn(outDir).sort();
    assert.equal(remaining.length, 2);
    assert.ok(!remaining.includes(old[0]));
    assert.ok(remaining.includes(old[1]));
    assert.ok(!fs.existsSync(path.join(outDir, `${old[0]}-wal`)));

    // The newest name sorts last, and it is the one this run produced.
    assert.deepEqual(countsOf(path.join(outDir, remaining.at(-1))), {
      users: 1,
      boards: 0,
      board_scenes: 0,
      files: 0,
    });
  });

  it("still exits zero when stdout is piped into head", () => {
    // Found by rehearsing a restore rather than by reading the code: `| head`
    // closes stdout mid-run, and an unhandled EPIPE would then report failure
    // for a backup that had already been written and verified. Exit status is
    // the only thing a cron wrapper reads, so it has to mean what it says.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 2 });

    const result = runPipedToHead("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(backupsIn(outDir).length, 1);
  });

  it("an interrupted backup leaves nothing wearing a backup's name", async () => {
    // SIGINT is an operator interrupting a long backup — exit 130, far more
    // reachable than a crash. `db.backup()` copies 100 pages a tick and on
    // failure only calls `close()`; it never unlinks. Writing straight to the
    // final name therefore left a partial copy called `lawha-<stamp>.db`, plus
    // a `-journal` nothing ever cleaned up, and the partial opens with
    // `integrity_check ok` and ZERO tables because the hot journal rolled it
    // back — so nothing downstream could tell it from a backup.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const dbPath = createBulkyDatabase(dataDir, { rows: 8000, users: 3 });

    const result = await runAndInterrupt(
      "backup.mjs",
      [outDir],
      { LAWHA_DB_PATH: dbPath },
      { watchDir: outDir },
    );

    // Guard the guard: if the copy had finished before the signal landed there
    // would be nothing left to assert about and this would pass for the wrong
    // reason. 130 is the script's own handler, SIGINT the default disposition.
    assert.ok(
      result.status === 130 || result.signal === "SIGINT",
      `expected an interrupted backup, got status ${result.status} / signal ${result.signal}: ${result.stdout}${result.stderr}`,
    );

    assert.deepEqual(
      fs.readdirSync(outDir),
      [],
      "an interrupted backup left files behind",
    );
  });

  it("--keep will not delete a readable backup to keep an unreadable one", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const genuine = ["lawha-20200101-000000.db", "lawha-20200102-000000.db"];
    for (const name of genuine) {
      stageVerifiedBackup(outDir, name, { users: 4 });
    }

    // What an interrupted backup used to leave: a backup's name, sorting
    // newest, and nothing inside. Staged rather than produced, so this test
    // stays deterministic — the interruption itself is pinned above.
    const partial = "lawha-20200103-000000.db";
    fs.writeFileSync(path.join(outDir, partial), "");

    const result = run("backup.mjs", [outDir, "--keep", "2"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    const remaining = backupsIn(outDir).sort();

    // Retention counted names, so `--keep 2` kept the partial and the new file
    // and deleted BOTH real backups. It must now keep the two it can read and
    // leave the one it cannot alone — never counted, never deleted, reported.
    assert.ok(
      remaining.includes(genuine[1]),
      `retention deleted a real backup: ${remaining.join(", ")}`,
    );
    assert.equal(countsOf(path.join(outDir, genuine[1])).users, 4);
    assert.ok(!remaining.includes(genuine[0]));
    assert.ok(remaining.includes(partial));
    assert.equal(remaining.length, 3);
    assert.match(result.stderr, /does not open as a Lawha backup/);
  });

  it("refuses --keep 0, which would delete the backup it just took", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = run("backup.mjs", [outDir, "--keep=0"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--keep needs a whole number/);
    assert.deepEqual(backupsIn(outDir), []);
  });
});

describe("backup.mjs — LAWHA_BACKUP_RECIPIENT unset or blank", () => {
  // "Opt-in is absolute": with no recipient configured, this script must
  // behave byte-identically to today. Every test above already pins that by
  // never setting the variable — these two exist to say so explicitly, and to
  // pin the one piece of behaviour none of them exercises: a variable that is
  // SET but empty must disable encryption exactly like leaving it unset,
  // mirroring `backupRecipient: parsed.LAWHA_BACKUP_RECIPIENT || null` in
  // `src/config.ts`.
  it("writes a plain .db and never mentions encryption when the variable is absent", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /encrypted/);
    const entries = fs.readdirSync(outDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^lawha-\d{8}-\d{6}\.db$/);
  });

  it("an explicit but blank LAWHA_BACKUP_RECIPIENT disables encryption, same as leaving it unset", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_BACKUP_RECIPIENT: "",
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /encrypted/);
    const entries = fs.readdirSync(outDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^lawha-\d{8}-\d{6}\.db$/);
  });
});

describe("backup.mjs — retention across both artefact forms", () => {
  // None of these need the real `age` binary: `stageAgeArtifact` stands in
  // for a finished encrypted backup using exactly what `isVerifiedAgeArtifact`
  // in `backup.mjs` actually checks (the format's magic header), the same way
  // `stageVerifiedBackup` stands in for a plaintext one using what
  // `isVerifiedBackup` checks. Retention's own logic — not `age` — is what is
  // under test here.
  it("--keep counts and prunes .db.age backups the same way it does .db ones", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const old = [
      "lawha-20200101-000000.db.age",
      "lawha-20200102-000000.db.age",
    ];
    for (const name of old) {
      stageAgeArtifact(outDir, name);
    }

    const result = run("backup.mjs", [outDir, "--keep", "2"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    const remainingAge = fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".age"));
    // The older of the two staged .age files is pruned; this run's own
    // artefact is plaintext (no recipient configured) and untouched by this
    // filter, so exactly the newer staged .age file is left.
    assert.deepEqual(remainingAge, [old[1]]);
  });

  it("a mixed directory of .db and .db.age backups prunes oldest-first across both forms", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    // Interleaved timestamps, alternating form, oldest to newest — the point
    // is that "oldest" means oldest across the COMBINED list, never oldest
    // within one extension while the other is left alone.
    stageVerifiedBackup(outDir, "lawha-20200101-000000.db", { users: 4 });
    stageAgeArtifact(outDir, "lawha-20200102-000000.db.age");
    stageVerifiedBackup(outDir, "lawha-20200103-000000.db", { users: 4 });
    stageAgeArtifact(outDir, "lawha-20200104-000000.db.age");

    const result = run("backup.mjs", [outDir, "--keep", "3"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    // Five candidates exist the instant retention runs: the four staged plus
    // this run's own new plaintext backup. `--keep 3` must remove exactly the
    // two OLDEST — the 01-01 `.db` and the 01-02 `.db.age` — regardless of
    // which extension either one wears.
    const remaining = fs
      .readdirSync(outDir)
      .filter((name) => ANY_BACKUP_NAME.test(name))
      .sort();

    assert.ok(!remaining.includes("lawha-20200101-000000.db"));
    assert.ok(!remaining.includes("lawha-20200102-000000.db.age"));
    assert.ok(remaining.includes("lawha-20200103-000000.db"));
    assert.ok(remaining.includes("lawha-20200104-000000.db.age"));
    assert.equal(remaining.length, 3);
  });

  it("an unreadable .db.age candidate is neither counted nor deleted, same rule as an unreadable .db one", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const genuine = [
      "lawha-20200101-000000.db.age",
      "lawha-20200102-000000.db.age",
    ];
    for (const name of genuine) {
      stageAgeArtifact(outDir, name);
    }
    // What a truncated or hand-edited encrypted file looks like: right name,
    // wrong (or absent) magic header. Retention cannot decrypt it to check
    // further — the private key never reaches this process by design — so
    // the header is the only signal available, same limitation the header
    // comment in `backup.mjs` states.
    const unreadable = "lawha-20200103-000000.db.age";
    stageUnreadableAgeArtifact(outDir, unreadable);

    const result = run("backup.mjs", [outDir, "--keep", "2"], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    const remaining = fs.readdirSync(outDir);
    assert.ok(
      remaining.includes(unreadable),
      "the unreadable candidate must survive, uncounted",
    );
    assert.ok(
      remaining.includes(genuine[1]),
      "the newer genuine .db.age backup must survive",
    );
    assert.ok(
      !remaining.includes(genuine[0]),
      "the older genuine .db.age backup must be pruned in its place",
    );
    assert.match(result.stderr, /does not open as a Lawha backup/);
  });
});

describe(
  "backup.mjs — encrypts to LAWHA_BACKUP_RECIPIENT",
  { skip: !ageAvailable && "age is not on PATH in this environment" },
  () => {
    it("writes lawha-<stamp>.db.age, unreadable as SQLite, decrypting to the same row counts", () => {
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createLiveDatabase(dataDir, {
        users: 3,
        boards: 2,
        scenes: 2,
        files: 1,
      });
      const { recipient, identityFile } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /integrity_check ok, encrypted/);

      const entries = fs.readdirSync(outDir);
      // Nothing plaintext, nothing left in a `.partial` staging name — just
      // the one finished, encrypted artefact.
      assert.equal(entries.length, 1);
      const [name] = entries;
      assert.match(name, /^lawha-\d{8}-\d{6}\.db\.age$/);

      const cipherFile = path.join(outDir, name);

      // The order this whole task exists to enforce, made visible from the
      // OUTSIDE: what landed on disk is not a database — if verification had
      // somehow run against ciphertext instead of the plaintext copy, this is
      // the assertion that would catch it. `new Database()` alone does NOT
      // throw here — better-sqlite3 validates the header lazily, only on
      // first actual access, exactly like `isVerifiedBackup` in `backup.mjs`
      // discovers a bad candidate through its own `pragma("integrity_check")`
      // call rather than through `new Database()` itself (confirmed against
      // the real binary while writing this test).
      assert.throws(() => {
        const probe = new Database(cipherFile, { readonly: true });
        try {
          probe.pragma("integrity_check");
        } finally {
          probe.close();
        }
      }, /file is not a database/);

      const plainFile = path.join(outDir, "decrypted.db");
      const decrypt = spawnSync("age", [
        "-d",
        "-i",
        identityFile,
        "-o",
        plainFile,
        cipherFile,
      ]);
      assert.equal(decrypt.status, 0, decrypt.stderr?.toString("utf8"));
      assert.deepEqual(countsOf(plainFile), {
        users: 3,
        boards: 2,
        board_scenes: 2,
        files: 1,
      });
    });

    it("never ships an unverified source as a main artefact, plaintext or encrypted", () => {
      // The order requirement, from the other direction: a database that
      // fails integrity_check/table verification must never reach MAIN
      // artefact encryption — nothing on disk after this run may match
      // `lawha-<stamp>.db` or `lawha-<stamp>.db.age`, the two names that
      // mean "restorable backup". If it did, `age` would happily encrypt
      // garbage and this run would exit 0 with a corrupt artefact nobody
      // could tell was corrupt without the private key.
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createLiveDatabase(dataDir);
      db.exec("DROP TABLE users");
      const { recipient } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no users table/);
      assert.deepEqual(
        fs
          .readdirSync(outDir)
          .filter((name) => /^lawha-\d{8}-\d{6}\.db(\.age)?$/.test(name)),
        [],
      );
    });

    it("encrypts the quarantined .rejected copy too, rather than leaving real data in the clear", () => {
      // A judgement call, not a defect fix: a `.rejected` copy is a COMPLETE
      // database, real board data if verification failed on a technicality
      // or an entirely different database's contents if `--db` pointed at
      // the wrong file — and "it failed verification" is not "safe to leave
      // in the clear" once an operator has chosen to encrypt this archive.
      // Inspecting it now needs the private key, same as inspecting a real
      // backup does.
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createLiveDatabase(dataDir, { boards: 2 });
      db.exec("DROP TABLE users");
      const { recipient, identityFile } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /kept for inspection, encrypted/);

      const entries = fs.readdirSync(outDir);
      // No plaintext .rejected file survives...
      assert.deepEqual(
        entries.filter((name) => name.endsWith(".rejected")),
        [],
      );
      // ...only its encrypted replacement.
      const rejectedAge = entries.filter((name) =>
        name.endsWith(".rejected.age"),
      );
      assert.equal(rejectedAge.length, 1);

      // Genuinely encrypted, not merely renamed: age -d recovers the SAME
      // bad database — still missing users, still holding the boards table
      // it had — rather than something that only wears an .age name.
      const cipherFile = path.join(outDir, rejectedAge[0]);
      const plainFile = path.join(outDir, "decrypted-rejected.db");
      const decrypt = spawnSync("age", [
        "-d",
        "-i",
        identityFile,
        "-o",
        plainFile,
        cipherFile,
      ]);
      assert.equal(decrypt.status, 0, decrypt.stderr?.toString("utf8"));
      const decryptedTables = tableNames(plainFile);
      assert.ok(!decryptedTables.includes("users"));
      assert.ok(decryptedTables.includes("boards"));
    });
  },
);

describe("backup.mjs — interrupted while age is still running", () => {
  // Both tests below share one shape: a signal lands while `encryptInPlace`
  // is mid-`await`, inside a REAL child process (see `writeSlowAgeStandIn`)
  // rather than something fakeable with mocked timers — the whole point is
  // that Node's own signal delivery, not this file's bookkeeping in the
  // abstract, is what gets exercised. `--keep` is irrelevant here and
  // omitted; retention never runs against a backup that was never finished.
  it("main artefact path: a signal during age leaves no plaintext database behind", async () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = await runAndInterruptDuringEncryption([outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_BACKUP_RECIPIENT: FIXTURE_RECIPIENT,
    });
    db.close();

    // 143 is this script's own SIGTERM handler (128 + 15); a bare `signal`
    // is the fallback if the OS's default disposition somehow won the
    // race instead — same either-or the existing SIGINT interruption test
    // above already asserts, one signal over.
    assert.ok(
      result.status === 143 || result.signal === "SIGTERM",
      `expected an interrupted run, got status ${result.status} / signal ` +
        `${result.signal}: ${result.stdout}${result.stderr}`,
    );

    assertNoPlaintextSqliteLeftIn(outDir);
    // Stronger than the byte check alone: this path was ALREADY correct
    // (`unfinished` stays `= partial` across its own `await
    // encryptInPlace`), so nothing at all — not even a `.partial` or
    // `.age.partial` — should survive.
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  /**
   * The regression this describe block exists for. Before the fix, `reject()`
   * cleared `unfinished` to `null` immediately after renaming `partial` to
   * `rejectedPlain` — before encrypting it, not after — so for the entire
   * `await encryptInPlace(...)` window that followed, the interrupt handler
   * believed there was nothing on disk to protect. Reproduced against the
   * pre-fix code exactly this way: a wrapper `age` that sleeps, SIGTERM at
   * 500ms, exit 143, stderr claiming "nothing was removed", and
   * `lawha-<stamp>.db.rejected` left behind — 8192 bytes, `SQLite format 3`
   * intact — in the one deployment mode whose entire point is that plaintext
   * must never be left there.
   */
  it("reject() path: a signal during age leaves no plaintext rejected copy behind", async () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { boards: 1 });
    db.exec("DROP TABLE users");

    const result = await runAndInterruptDuringEncryption([outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_BACKUP_RECIPIENT: FIXTURE_RECIPIENT,
    });
    db.close();

    assert.ok(
      result.status === 143 || result.signal === "SIGTERM",
      `expected an interrupted run, got status ${result.status} / signal ` +
        `${result.signal}: ${result.stdout}${result.stderr}`,
    );

    assertNoPlaintextSqliteLeftIn(outDir);
    assert.deepEqual(fs.readdirSync(outDir), []);
    // Not load-bearing for the byte check above, but pins the corrected,
    // honest message too — the pre-fix code printed "nothing was removed"
    // here, which was false.
    assert.match(
      result.stderr,
      /the rejected copy awaiting encryption was removed/,
    );
    assert.doesNotMatch(result.stderr, /nothing was removed/);
  });
});

/**
 * `LAWHA_DB_KEY` — the live database is SQLCipher, so the backup of it must be
 * too (Task 7B).
 *
 * The constraint every test below serves: **no plaintext database may reach
 * disk because a backup ran.** Not a `.partial`, not a `.rejected`, not a
 * temporary anything — and not conditional on `LAWHA_BACKUP_RECIPIENT`, which
 * is the other half of this feature and is independent by design. A deployment
 * that set only `LAWHA_DB_KEY` must not have its boards written out in the
 * clear by the thing that is supposed to protect them.
 *
 * The second constraint is that the verification stays REAL. `integrity_check`
 * and the four row counts are the only reason to trust an artefact at all, and
 * an artefact that is "verified" without being read is not verified — so the
 * counts below are read back THROUGH THE KEY rather than believed from stdout.
 */
describe("backup.mjs — with LAWHA_DB_KEY set", () => {
  /** Comfortably over the floor `src/config.ts` enforces (16). */
  const KEY = "correct-horse-battery-staple";
  const WRONG_KEY = "wrong-horse-battery-staple-98";

  it("writes an artefact that is not readable as a plaintext SQLite database", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 3,
      boards: 2,
    });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);

    const names = backupsIn(outDir);
    assert.equal(names.length, 1, `expected one backup, got ${names}`);

    const artifact = path.join(outDir, names[0]);
    assert.ok(
      !readsAsPlaintextSqlite(artifact),
      "the artefact still begins `SQLite format 3` — the backup of an " +
        "encrypted database was written in the clear",
    );
  });

  it("counts the rows that only exist in the -wal, and they are right when read back through the key", () => {
    // The same experiment the very first test in this file runs, one layer
    // down: the connection is still open and nothing has checkpointed, so
    // every row lives in `lawha.db-wal`. A copy that misses them is the
    // original disaster wearing an encrypted hat.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 5,
      boards: 4,
      scenes: 4,
      files: 2,
    });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /5 {2}users/);
    assert.match(result.stdout, /4 {2}boards/);

    const artifact = path.join(outDir, backupsIn(outDir)[0]);
    assert.deepEqual(encryptedCountsOf(artifact, KEY), {
      users: 5,
      boards: 4,
      board_scenes: 4,
      files: 2,
    });
  });

  it("passes integrity_check when opened with the key, and refuses the wrong one", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 1,
    });

    assert.equal(
      run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      }).status,
      0,
    );
    db.close();

    const artifact = path.join(outDir, backupsIn(outDir)[0]);
    const opened = openEncrypted(artifact, KEY, { readonly: true });
    assert.equal(opened.pragma("integrity_check")[0].integrity_check, "ok");
    opened.close();

    // Negative space: if the wrong key opened it, the check above would be
    // proving nothing about which key the artefact is actually under.
    assert.throws(() => openEncrypted(artifact, WRONG_KEY, { readonly: true }));
  });

  it("leaves nothing plaintext anywhere in the archive directory", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 2,
    });

    /**
     * A value nothing in SQLite would produce on its own, so a hit is a hit.
     * Same technique, and the same reason, as the CANARY in
     * `tests/integration/dbEncryption.test.ts`: "the header is not the magic"
     * is a claim about sixteen bytes, where "a row's own content does not
     * appear anywhere in this file" is a claim about the whole artefact.
     */
    const CANARY = "lawha-canary-9f3a7c";
    db.prepare("INSERT INTO boards (id, name) VALUES ('c', ?)").run(CANARY);

    assert.equal(
      run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
      }).status,
      0,
    );
    db.close();

    // The whole directory, on the bytes — the staging `.partial` is the file
    // this would catch if the copy were ever made in the clear and encrypted
    // afterwards.
    assertNoPlaintextSqliteLeftIn(outDir);

    for (const name of fs.readdirSync(outDir)) {
      assert.ok(
        !fs.readFileSync(path.join(outDir, name)).includes(CANARY),
        `${name} contains a board's name in the clear`,
      );
    }

    // And it really did travel: the row is in the artefact, readable with the
    // key. Without this the assertion above would pass just as happily against
    // a backup that had lost the row entirely.
    const artifact = path.join(outDir, backupsIn(outDir)[0]);
    const opened = openEncrypted(artifact, KEY, { readonly: true });
    assert.equal(
      opened.prepare("SELECT name FROM boards WHERE id = 'c'").get().name,
      CANARY,
    );
    opened.close();
  });

  it("quarantines a bad artefact without decrypting it", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      boards: 2,
    });
    // Verification fails on the four-table check, which is the cheapest way
    // to reach `reject()` — and a `.rejected` copy is a COMPLETE database.
    db.exec("DROP TABLE users");

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kept for inspection/);
    assertNoPlaintextSqliteLeftIn(outDir);
  });

  it("refuses, and writes nothing, when the key does not open the database", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 1,
    });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: WRONG_KEY,
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAWHA_DB_KEY/);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("refuses a key the server itself would not boot with", () => {
    // Fifteen characters, one under `MIN_DB_KEY_LENGTH`. Backing up with a key
    // the server refuses would mean an archive nothing can be restored into.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });

    const result = run("backup.mjs", [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "123456789012345",
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16|under 16|16 characters/);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("says an empty file is empty, rather than guessing at encryption", () => {
    // The guard above answers "not the SQLite magic", and a zero-byte file
    // has no magic while being neither encrypted nor damaged. Without its own
    // branch the operator is sent hunting for a key that never existed.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const dbPath = path.join(dataDir, "lawha.db");
    fs.writeFileSync(dbPath, "");

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty file/);
    assert.doesNotMatch(result.stderr, /ENCRYPTED/);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("says what is wrong when the database is encrypted and no key was given", () => {
    // The reachable operator mistake: `LAWHA_DB_KEY` lives in `lawha.env`,
    // which only ever reaches the containers, so a backup run BY HAND on the
    // host has no key unless the operator exports one. "file is not a
    // database" is the wrong sentence to hand them.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 1,
    });

    const result = run("backup.mjs", [outDir], { LAWHA_DB_PATH: dbPath });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LAWHA_DB_KEY/);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it("retention still counts and prunes encrypted artefacts", () => {
    // The failure this pins is the one `AGE_BACKUP_NAME` already caused once:
    // retention verifies every candidate before counting it, so a verifier
    // that cannot open an encrypted artefact reports every backup as
    // unreadable, keeps all of them, and fills the disk — quietly, because
    // every run still exits 0.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 1,
    });
    const env = { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY };

    const first = run("backup.mjs", [outDir], env);
    assert.equal(first.status, 0, first.stderr);

    // The stamp has one-second resolution, so a second run inside the same
    // second collides on the name; the script says so and exits non-zero.
    const older = path.join(outDir, backupsIn(outDir)[0]);
    fs.renameSync(older, path.join(outDir, "lawha-20200101-000000.db"));

    const second = run("backup.mjs", [outDir, "--keep", "1"], env);
    db.close();

    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(
      second.stderr,
      /does not open as a Lawha backup/,
      "retention could not read an artefact this same script had just written",
    );
    assert.deepEqual(backupsIn(outDir).length, 1);
    assert.ok(!fs.existsSync(path.join(outDir, "lawha-20200101-000000.db")));
  });

  it("still counts and prunes the plaintext backups an archive already held", () => {
    // The transition an operator actually lives through: `LAWHA_DB_KEY` is set
    // today, and every backup taken before today is plaintext and sitting in
    // the same directory. Retention that cannot read those keeps them forever.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
      users: 1,
    });
    stageVerifiedBackup(outDir, "lawha-20200101-000000.db");
    stageVerifiedBackup(outDir, "lawha-20200102-000000.db");

    const result = run("backup.mjs", [outDir, "--keep", "1"], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: KEY,
    });
    db.close();

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /does not open as a Lawha backup/);
    assert.equal(backupsIn(outDir).length, 1);
  });
});

/**
 * The strongest form of the constraint, and the only test here that can
 * actually assert it: **at no moment during a run does a plaintext copy of the
 * database exist on disk.**
 *
 * Every other test in the keyed suite above looks at the END of a run, which
 * an implementation that copied plaintext and encrypted it afterwards would
 * pass just as easily — the plaintext would be gone by the time anyone looked.
 * The only way to tell the two designs apart is to stop the process WHILE the
 * copy is being written and read what is sitting there.
 *
 * SIGKILL rather than SIGTERM, deliberately. SIGTERM is catchable, and this
 * script's handler removes the partial copy on its way out — which is correct
 * behaviour and would destroy the evidence. SIGKILL cannot be caught, so what
 * remains on disk is exactly what the copy had written at that instant, with
 * no cleanup and no chance for the script to tidy up in its own favour.
 *
 * THE ASSERTION IS ON THE BLOB CONTENT, not on the header, and that is not a
 * stylistic preference — it was measured. A partial copy caught mid-write has
 * ZEROES in its first sixteen bytes whether it is plaintext or ciphertext:
 * SQLite has not written page 1 yet. So the `SQLite format 3` check that every
 * other test here relies on is VACUOUS at this instant, in both designs, and a
 * test built on it would have passed against a plaintext copy. What does
 * discriminate is the fixture's own filler — 2 KB blobs of `0x07` per row —
 * which appears in long runs throughout a plaintext copy and nowhere in a
 * ciphertext one. Measured both ways: keyed run false, unkeyed run true.
 */
describe("backup.mjs — killed mid-copy with LAWHA_DB_KEY set", () => {
  const KEY = "correct-horse-battery-staple";

  /**
   * 64 bytes of the filler `createBulkyEncryptedDatabase` stores. Long enough
   * that no ciphertext plausibly produces it by accident (2^-512 for random
   * bytes), short enough to sit well inside one 2 KB blob however the pages
   * fall.
   */
  const PLAINTEXT_FILLER = Buffer.alloc(64, 7);

  it("leaves a partial copy whose bytes are ciphertext, not database content", async () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const dbPath = createBulkyEncryptedDatabase(dataDir, KEY);

    const result = await runAndInterruptWhen(
      "backup.mjs",
      [outDir],
      { LAWHA_DB_PATH: dbPath, LAWHA_DB_KEY: KEY },
      {
        signal: "SIGKILL",
        // 64 KB in, so the copy is genuinely writing DATA pages rather than
        // merely having created the destination.
        ready: () =>
          fs
            .readdirSync(outDir)
            .some(
              (name) =>
                name.endsWith(".partial") &&
                fs.statSync(path.join(outDir, name)).size > 65536,
            ),
      },
    );

    assert.equal(
      result.signal,
      "SIGKILL",
      `expected a killed run, got status ${result.status}: ` +
        `${result.stdout}${result.stderr}`,
    );

    const partials = fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".db.partial"));
    assert.equal(
      partials.length,
      1,
      `expected exactly one partial copy to inspect, found ${fs.readdirSync(
        outDir,
      )}`,
    );

    const bytes = fs.readFileSync(path.join(outDir, partials[0]));
    assert.ok(
      bytes.length > 65536,
      "the partial copy is too small to have written any table data",
    );
    assert.ok(
      !bytes.includes(PLAINTEXT_FILLER),
      "the partial copy contains the database's own blob content in the " +
        "clear — the copy is being made in plaintext and encrypted afterwards",
    );
    assert.ok(
      !bytes.includes(Buffer.from("SQLite format 3")),
      "the partial copy carries a plaintext SQLite header",
    );

    // And the belt-and-braces sweep the rest of this file uses, over
    // everything the killed run left behind, sidecars included.
    assertNoPlaintextSqliteLeftIn(outDir);
  });

  /**
   * The negative control, and the test above is worth nothing without it.
   *
   * `!bytes.includes(PLAINTEXT_FILLER)` passes trivially if the fixture stops
   * storing that filler — change `createBulkyEncryptedDatabase`'s blob byte
   * and the assertion goes green while proving nothing at all. So the same
   * interruption is run against an UNKEYED source, where the copy genuinely
   * is plaintext, and the filler must be found. Measured both ways before
   * either was written: keyed partial 258048 bytes, filler absent; unkeyed
   * partial 245760 bytes, filler present.
   *
   * It also pins the more surprising half of that measurement. Both partials
   * have ZEROES in their first sixteen bytes — SQLite has not written page 1
   * yet — so the `SQLite format 3` check every other test here leans on is
   * VACUOUS at this instant, in both designs. Asserting that here means the
   * next person to "simplify" the test above into a header check finds out
   * from a failure rather than from an incident.
   */
  it("finds that filler in an UNKEYED partial, which is what makes its absence mean something", async () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const dbPath = createBulkyDatabase(dataDir, {
      rows: 12000,
      // The keyed fixture cannot use 512 (SQLCipher reserves part of every
      // page and does not work there), so the control has to match it or the
      // two runs are not comparable.
      pageSize: 4096,
    });

    const result = await runAndInterruptWhen(
      "backup.mjs",
      [outDir],
      { LAWHA_DB_PATH: dbPath },
      {
        signal: "SIGKILL",
        ready: () =>
          fs
            .readdirSync(outDir)
            .some(
              (name) =>
                name.endsWith(".partial") &&
                fs.statSync(path.join(outDir, name)).size > 65536,
            ),
      },
    );

    assert.equal(
      result.signal,
      "SIGKILL",
      `expected a killed run, got status ${result.status}: ` +
        `${result.stdout}${result.stderr}`,
    );

    const [partial] = fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".db.partial"));
    assert.ok(partial, "no partial copy was left to inspect");

    const bytes = fs.readFileSync(path.join(outDir, partial));
    assert.ok(
      bytes.includes(PLAINTEXT_FILLER),
      "an UNKEYED partial copy does not contain the fixture's own filler — " +
        "the fixture or the filler has changed, and the keyed assertion " +
        "above is now vacuous",
    );
    // The vacuity the header check would have had. Asserted, not assumed.
    assert.notEqual(
      bytes.subarray(0, 15).toString("latin1"),
      "SQLite format 3",
      "a mid-write partial now DOES carry the magic in its first bytes — if " +
        "that is genuinely true, the keyed test above may use the cheaper " +
        "header check after all; verify before changing it",
    );
  });
});

/**
 * **The property this suite exists for, stated as a property rather than as an
 * instance: these scripts must LOAD AND RUN with the cipher driver absent.**
 *
 * The instance was a Critical defect that reached the running deployment. A
 * top-level `import CipherDatabase from "better-sqlite3-multiple-ciphers"` was
 * added to `backup.mjs` and `restore.mjs`; `docker-compose.yml` bind-mounts
 * `./lawha-server/scripts` into the `lawha-backup` container read-only, so the
 * edit went live against an image whose `node_modules` predated the dependency
 * by a day. Reproduced in the running container:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *     'better-sqlite3-multiple-ciphers' imported from
 *     /opt/lawha/scripts/backup.mjs
 *
 * An ESM top-level import resolves before the module body runs, so this
 * preceded argument parsing and every refusal in the file — on a deployment
 * that had never set `LAWHA_DB_KEY` and had therefore opted into nothing. The
 * six-hourly backup and the recovery path both died at the same instant, and
 * every test in this repository stayed green, because the repository's own
 * `node_modules` has the package.
 *
 * So the tests below do not check "is the import dynamic". They run the real
 * script, from a directory that mirrors the container's layout, where the
 * cipher driver genuinely cannot be resolved — see
 * `stageWithoutCipherDriver`. A future change that re-introduces a top-level
 * import of anything the image may not have fails here, whatever the package.
 */
describe("backup.mjs — with the cipher driver absent from resolution", () => {
  it("takes a complete, verified, unkeyed backup", () => {
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const isolated = scratch("container");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 3, boards: 2 });
    const scriptsDir = stageWithoutCipherDriver(isolated, ["backup.mjs"]);

    const result = runAt(path.join(scriptsDir, "backup.mjs"), [outDir], {
      LAWHA_DB_PATH: dbPath,
    });
    db.close();

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);

    // Not merely "it exited 0" — the artefact is a real backup, with the rows
    // that were still in the -wal. A script that loads and then does nothing
    // useful would be a different failure with the same exit code.
    const [name] = backupsIn(outDir);
    assert.ok(name, `no backup written: ${result.stdout}${result.stderr}`);
    assert.deepEqual(countsOf(path.join(outDir, name)), {
      users: 3,
      boards: 2,
      board_scenes: 0,
      files: 0,
    });
  });

  it("still prints its usage, which is what a failure at module load destroys", () => {
    // The sharpest symptom of the defect: `--help` did not work either,
    // because nothing in the file had run yet. If this passes and the test
    // above fails, the regression is in the backup; if BOTH fail, it is at
    // module load, which is the far worse one.
    const isolated = scratch("container");
    const scriptsDir = stageWithoutCipherDriver(isolated, ["backup.mjs"]);

    const result = runAt(path.join(scriptsDir, "backup.mjs"), ["--help"], {});

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /usage: /);
  });

  it("refuses a KEYED run there by name, and says which command fixes it", () => {
    // The other half of the contract. Absent driver plus LAWHA_DB_KEY is a
    // genuine "this cannot be done here", and it must arrive as a sentence
    // naming the rebuild rather than as a module-resolution stack trace —
    // which is all an operator would otherwise get, from a script whose whole
    // job is to be trustworthy at 3am.
    const dataDir = scratch("live");
    const outDir = scratch("out");
    const isolated = scratch("container");
    const { dbPath, db } = createLiveDatabase(dataDir, { users: 1 });
    const scriptsDir = stageWithoutCipherDriver(isolated, ["backup.mjs"]);

    const result = runAt(path.join(scriptsDir, "backup.mjs"), [outDir], {
      LAWHA_DB_PATH: dbPath,
      LAWHA_DB_KEY: "correct-horse-battery-staple",
    });
    db.close();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker compose build/);
    assert.doesNotMatch(result.stderr, /^\s+at /m);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });
});

/**
 * The negative control for the suite above, by injecting the actual defect.
 *
 * Three passing tests that the cipher driver's absence is survivable prove
 * nothing on their own — they would pass just as well if `stageWithoutCipherDriver`
 * quietly failed to hide the package, which is the failure mode that makes
 * this whole technique worthless. So the fault is put back: a copy of
 * `backup.mjs` with a TOP-LEVEL import of the cipher driver, run from the same
 * isolated root, must fail the way the live deployment did.
 *
 * Same reasoning, and the same guards, as the mutation suite in
 * `encrypt-db.test.mjs`: the mutation asserts it actually changed something,
 * so it can never pass by mutating nothing. The mutant lives inside the temp
 * root rather than beside the original — unlike that file's, it must NOT
 * resolve the repository's `node_modules`, which is the entire point.
 */
describe("backup.mjs — the absent-driver tests can actually fail", () => {
  it("a top-level import of the cipher driver dies before the module body runs", () => {
    const isolated = scratch("container");
    const scriptsDir = stageWithoutCipherDriver(isolated, ["backup.mjs"]);
    const mutantPath = path.join(scriptsDir, "backup.mjs");

    const original = fs.readFileSync(mutantPath, "utf8");
    const target = 'import Database from "better-sqlite3";';
    assert.ok(
      original.includes(target),
      "the mutation target is gone from backup.mjs",
    );
    const mutated = original.replace(
      target,
      `${target}\nimport _Cipher from "better-sqlite3-multiple-ciphers";`,
    );
    assert.notEqual(mutated, original, "the mutation did not apply");
    fs.writeFileSync(mutantPath, mutated);

    // `--help`, the cheapest possible invocation, and one that touches no
    // database at all. It still dies, which is precisely what made the live
    // defect so total.
    const result = runAt(mutantPath, ["--help"], {});

    assert.notEqual(
      result.status,
      0,
      "a top-level cipher-driver import survived a run with the driver " +
        "absent — stageWithoutCipherDriver is not hiding the package, and " +
        "every test in the suite above is vacuous",
    );
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  });
});

/**
 * **Both halves at once**, which nothing tested until now.
 *
 * `LAWHA_DB_KEY` and `LAWHA_BACKUP_RECIPIENT` are independent by design and
 * every test in this file set exactly one of them — they lived in disjoint
 * `describe` blocks and no single run ever had both. The composition has three
 * moving parts in a fixed order (`VACUUM INTO` → verify through the key →
 * `encryptInPlace`) and nothing pinned their interaction, so a change that
 * encrypted before verifying, or verified the ciphertext instead of the
 * database, would have gone green.
 *
 * The claim under test is NESTING, and it is asserted by peeling: `age -d`
 * must yield SQLCipher ciphertext, not a database. If the two layers were
 * applied to the wrong things — or one silently replaced the other — the
 * decrypted bytes would open without a key, which is precisely the leak the
 * SQLCipher half exists to prevent for anybody who holds the age identity.
 */
describe(
  "backup.mjs — LAWHA_DB_KEY and LAWHA_BACKUP_RECIPIENT together",
  { skip: !ageAvailable && "age is not on PATH in this environment" },
  () => {
    const KEY = "correct-horse-battery-staple";

    it("wraps a SQLCipher database in age, and peeling one layer does not reveal the other", () => {
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
        users: 3,
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
      // Both facts said out loud, separately: a restore may need either key,
      // both, or neither, and the operator reading this line is the one who
      // will have to find out which.
      assert.match(result.stdout, /SQLCipher/);
      assert.match(result.stdout, /encrypted/);

      const [name] = fs
        .readdirSync(outDir)
        .filter((entry) => entry.endsWith(".db.age"));
      assert.ok(name, `no .db.age written: ${result.stdout}${result.stderr}`);

      // Layer one: age. What comes out must NOT be a database.
      const peeled = path.join(outDir, "peeled.db");
      const decrypt = spawnSync("age", [
        "-d",
        "-i",
        identityFile,
        "-o",
        peeled,
        path.join(outDir, name),
      ]);
      assert.equal(decrypt.status, 0, decrypt.stderr?.toString("utf8"));
      assert.ok(
        !readsAsPlaintextSqlite(peeled),
        "peeling the age layer revealed a PLAINTEXT database — the two " +
          "halves are not nested, and anyone holding the age identity has " +
          "every board",
      );

      // Layer two: SQLCipher. Only now is it a database, and the right one.
      assert.deepEqual(encryptedCountsOf(peeled, KEY), {
        users: 3,
        boards: 2,
        board_scenes: 0,
        files: 0,
      });
    });

    it("leaves nothing plaintext in the archive, and verifies before encrypting", () => {
      // The ordering that matters and that nothing pinned: the row counts
      // below are read out of the DATABASE, through the key, before `age`
      // ever runs. A run that encrypted first would have nothing left to
      // count and could only report on bytes it cannot read.
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
        users: 4,
      });
      const { recipient } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: KEY,
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /4 {2}users/);
      assertNoPlaintextSqliteLeftIn(outDir);
      assert.deepEqual(
        fs.readdirSync(outDir).filter((entry) => !entry.endsWith(".db.age")),
        [],
        "something other than the finished ciphertext survived the run",
      );
    });

    it("refuses, and writes nothing, when the database key is wrong", () => {
      // Order of failure matters: the key is used to OPEN the source, so a
      // wrong one must stop the run before `age` is ever spawned. Otherwise
      // the archive collects encrypted artefacts of nothing.
      const dataDir = scratch("live");
      const outDir = scratch("out");
      const keyDir = scratch("keys");
      const { dbPath, db } = createEncryptedLiveDatabase(dataDir, KEY, {
        users: 1,
      });
      const { recipient } = generateAgeKeypair(keyDir);

      const result = run("backup.mjs", [outDir], {
        LAWHA_DB_PATH: dbPath,
        LAWHA_DB_KEY: "wrong-horse-battery-staple-98",
        LAWHA_BACKUP_RECIPIENT: recipient,
      });
      db.close();

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /LAWHA_DB_KEY/);
      assert.deepEqual(fs.readdirSync(outDir), []);
    });
  },
);
