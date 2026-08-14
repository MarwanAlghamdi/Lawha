# 0020 — Encryption at rest, in two halves with different keys

**Status:** accepted **Date:** 2026-08-07 **Neither half is enabled on this deployment.** `LAWHA_BACKUP_RECIPIENT` and `LAWHA_DB_KEY` are both unset, `~/lawha-data/lawha.db` still begins `SQLite format 3`, and every file in `~/lawha-backups` is plaintext. Both settings are opt-in, and this ADR is written so that opting in is a deliberate act with a stated cost.

## What this does NOT protect, stated before anything else

**Half B — `LAWHA_DB_KEY`, the live database — does not protect a stolen machine.** The key sits in `lawha.env` on the same disk as `lawha.db`, because the server has to restart unattended and cannot prompt anybody for a passphrase. Whoever takes the box has both files. Nothing about SQLCipher changes that, and no arrangement of this setting ever will.

What Half B buys is protection against a copied **file**: a stray `lawha.db` on a share, a decommissioned drive, a backup restored to the wrong place, a tar handed to somebody who needed the boards but not the credentials. That is a smaller claim than "encryption at rest" usually implies, and it is the true one. `src/config.ts` says the same thing on the setting itself, so that nobody reads only one of the two.

**Half A — `LAWHA_BACKUP_RECIPIENT`, the archive — is the exception, and it is the stronger half.** The private key is never on the machine at all. A fully compromised server, running as root, reading every file it owns, cannot decrypt a single backup it has ever written. That is a real property and it is the reason this half shipped first.

If the expectation was "someone steals the laptop and gets nothing", **only A delivers that, and only for the archive.**

## Two halves, two keys, sharing nothing but a section of `lawha.env`

| Half | Setting | Cryptography | Where the key lives | Protects |
| --- | --- | --- | --- | --- |
| **A** — the backup archive | `LAWHA_BACKUP_RECIPIENT` | `age`, asymmetric — an `age1…` **public** key | the private half is **with you**, never on the machine | a copy that leaves the building |
| **B** — the live database | `LAWHA_DB_KEY` | SQLCipher, symmetric | `lawha.env`, on the same disk as the database | a copied _file_ — a share, an old drive, a misplaced restore |

They are independent. A can be on with B off, which is the recommended order and the one this deployment would take. Turning B on does not change what A does, and `age` still layers on top of a keyed artefact: `encryptInPlace` reads bytes and does not care what they are.

Both settings are validated at config load rather than at first use, for the same reason. A malformed recipient or a three-character key that is only rejected when a backup finally runs is a failure discovered at 3am, six hours after the operator who fat-fingered `lawha.env` closed their laptop. Refusing to boot is the loud version of the same mistake.

## Why `age` inside the backup image is safe, when rsync and ssh were refused

`docker-compose.yml` and `docker/lawha-backup.sh` already refuse to put rsync or ssh in the backup image, and say why: an off-host mirror over ssh needs a **private** key inside the container whose entire job is to hold your data. Compromise that container and you have both the backups and the credentials to wherever they are copied. So the off-site mirror is a mounted path (`LAWHA_BACKUP_MIRROR_DIR`) and the credentials stay on the host.

`age` does not have that shape. Only the **public** key goes into the image, in `LAWHA_BACKUP_RECIPIENT`. The container can write ciphertext it can never read back — which is exactly the property that makes the archive worth encrypting in the first place. That is the same distinction the compose file already draws, applied to a new tool rather than a new exception to an old rule.

`age` is installed from Debian (`1.1.1-1+b3` on `node:22-slim`, verified in the built image) rather than vendored, because a fetched binary would mean this image tracking upstream age releases itself with no way to verify one against the other at build time. It is installed in the `runtime` stage only; `lawha-backup` runs the same image as `lawha-server`, so both get it, and the `deps`/`build` stages never shell out to it.

## Half A — what gets encrypted, and in what order

**The database artefact, after `backup.mjs` has verified it — never before.** `integrity_check` and the four per-table row counts run first. A corrupt file encrypted promptly is still corrupt, and the verification is the only reason to trust the artefact at all. The result is `lawha-<stamp>.db.age`, written under its own `.age.partial` name so that nothing wears a finished artefact's name until it is finished.

**The `config/` mirror — `lawha.env`, `./.env` and `certs/`.** This is the highest-value thing the whole feature does. A stolen archive without it is "everyone's boards". With `LAWHA_MASTER_PASSWORD` and the CA private key sitting in plaintext beside them, it is "everyone's boards **and** the credentials to the running deployment".

**And `LAWHA_DB_KEY` is in that file**, which is the one entry in the enumeration above that folds Half B back into Half A. Turn Half B on **without** a recipient and `docker/lawha-backup.sh` copies `lawha.env` — SQLCipher key included, mode 0600 — into the archive **beside the ciphertext it opens**. Anyone holding the archive holds both halves, and the database encryption has bought that adversary nothing. It is not a defect in either half; it is what "the key lives on the same disk" means, applied to the copy of the disk. Two ways out, and one of them has to be chosen deliberately: set `LAWHA_BACKUP_RECIPIENT` as well, so the copy is written as `config/lawha.env.age`; or set `LAWHA_BACKUP_CONFIG=false` and keep your own copy of `lawha.env` somewhere the archive is not. The scheduler says this at every start-up when it sees a key and no recipient, and never prints the key itself.

**Each blob, once, on first copy.** Blobs are content-addressed and immutable, so encrypting on first mirror preserves the append-only property and the one-stat-per-blob-per-run cost. Nothing is ever re-encrypted. (This is also where the feature has a hole that needs an operator; see the next section.)

**The `.rejected` quarantine too.** A backup that fails verification is renamed rather than deleted, and it is still a complete copy of real board data. Leaving it plaintext in an archive that was deliberately chosen to be encrypted would be a hole with a filename on it.

A filename convention change turned out to have a blast radius. `BACKUP_NAME` — the regex deciding what counts as a backup — existed in **three** places, and the third was the one that mattered: `src/lib/backupVerify.ts` feeds `backupArchive.ts` feeds the `/admin` panel. Left alone, turning encryption on would have made the panel list **zero** backups for ever while the archive filled up normally. A fourth was found the same round: the download filename. `backupVerifyParity.test.ts` now pins both forms.

## Losing the backup private key loses every backup

This is inherent, not a defect. `age` is asymmetric precisely so that the machine cannot decrypt what it wrote; the corollary is that nothing on the machine can help you if you lose the other half. There is no escrow, no recovery key, and no administrator who can be asked — the same posture ADR 0012 arrived at for boards, for the same reason: a recovery path that exists is a recovery path an attacker can also walk.

`lawha.env.example` carries this warning **beside** `LAWHA_BACKUP_RECIPIENT`, not in a footnote, because the moment it needs to be known is the moment the setting is being written down for the first time.

## The blob migration is REQUIRED, not tidy-up

`mirror_blobs` decides "already mirrored" by testing whether the target file exists — and the target name already carries the `.age` suffix once a recipient is configured. So a blob mirrored under one regime is never revisited under the other. That is a deliberate choice: reconciling the two forms would mean re-reading and re-encrypting the whole archive on the run after a recipient is set, turning a cheap append-only mirror into an O(archive) job.

The consequence was not anticipated by the plan and it is the reason this section exists. **Without a migration the feature never converges.** For any blob whose live source still exists, the first cycle after a recipient is set does not find a `.age` target, so it _manufactures_ one — beside a plaintext copy it never removes and never looks at again. Both persist for ever. The archive ends up holding the same image twice, once encrypted and once not, and the plaintext one is the one that matters to anybody who steals it.

So there are two pieces:

- **A startup warning**, printed once per container start rather than once per cycle, counting the blobs in the mirror that predate the recipient.
- **`--encrypt-existing-blobs`**, run by hand, once:

  ```bash
  docker compose exec lawha-backup /opt/lawha/lawha-backup.sh --encrypt-existing-blobs
  ```

  It is never called from the loop, because running it every six hours is exactly the cost the design refuses. It is idempotent, fail-closed, and encrypts to a `.copying` staging name, renames onto the final `.age` name, and only then removes the plaintext. There is no window in which the plaintext is gone and no readable ciphertext has replaced it.

**Turning `LAWHA_BACKUP_RECIPIENT` on and not running this leaves a plaintext copy of every existing image in the archive, permanently.** That is the whole reason it is in this ADR rather than in a script comment.

## Half A — the artefact is ciphertext from its first written byte

The original design encrypted a plaintext artefact after writing it. Once Half B existed that stopped being good enough, and the backup and restore paths were reworked (this was not in the plan; Half B is unusable without it).

`db.backup()` — SQLite's online backup API, which yields every 100 pages — **refuses** an encrypted source paired with the plain destination it creates for itself: `backup is not supported with incompatible source and target databases`. Nothing plaintext is written; the pairing is simply rejected. `sqlcipher_export`, which the spec called for, does not exist in this driver (see below). What replaces it on every keyed path is **`VACUUM INTO`**, which SQLite3 Multiple Ciphers carries the source's cipher and key across for, with no DDL surgery. Measured cross-process against a live, uncheckpointed, still-open WAL database — the shape `backup.mjs` actually runs in — the target opened with the key, refused any other key, passed `integrity_check`, held every row including the ones still sitting in the source's `-wal`, had no sidecars, and left the source byte-identical.

So on a keyed deployment there is **no plaintext staging file at any point**, not even briefly. The test that actually proves this is a SIGKILL mid-copy (SIGTERM is caught and the handler removes the partial, destroying the evidence) — and writing it changed how it had to be asserted. A partial copy caught mid-write has **zeroes** in its header under both designs, because SQLite has not written page 1 yet; asserting on the magic alone would have passed against a plaintext implementation. The shipped assertion is on content: a long run of the fixture's filler bytes, which appears throughout a plaintext copy and nowhere in a ciphertext one.

**The cost, stated rather than hidden:** `VACUUM INTO` is one synchronous statement where `db.backup()` yields. On the `/admin` "Back up now" path that means a keyed deployment with a large database stalls the server for the duration of the copy. The unkeyed path is byte-for-byte unchanged and there is a test pinning that. There is no yielding alternative in this driver that produces an encrypted target.

## The `/admin` download, and what it still does not say

ADR 0017's "back up now and download" hands back an encrypted file once a recipient is set. That is the point — it closes the finding that an admin session can walk off with every board and every password hash — but it makes the button less immediately useful, and the panel says so at the point of download rather than leaving somebody with a file they cannot open and no explanation.

**`needsPrivateKey` covers the `age` key only.** `backupArchive.ts` computes it as `AGE_BACKUP_NAME.test(name) || blobsHaveCiphertext`, so a _keyed but unencrypted-to-a-recipient_ deployment hands out tars whose `lawha.db` cannot be opened without `LAWHA_DB_KEY`, and the panel does not mention it. No data is at risk and nothing fails silently at restore time — `restore.mjs` names the key — but the UI is quietly incomplete. Recorded here rather than fixed, because it wants either a second flag on the listing or a line in the panel, and neither was in scope. _(The first sentence is still true and is what the code does. The rest — "the panel does not mention it", "recorded here rather than fixed", "neither was in scope" — was false **twenty-five minutes after this file was written**. See Amendments; it wanted both, and got both.)_

## Half B — the boot failure mode is the whole design

A wrong or missing key must **refuse the boot, loudly**. What it must never do is present as an _empty_ database. That path exists and it is well-trodden: an empty database seeds a first-boot administrator, prints a fresh password in a box, and looks **exactly** like the data having been wiped, while it sits intact on disk a rename away. Somebody following that appearance to its conclusion would restore a backup over data that was never damaged.

Three things make the refusal work, and none of them may be weakened:

1. **`new Database(dbPath)` is deliberately bare** — no `try`, no `catch`, nothing to swallow a throw.
2. **A one-statement probe runs before anything else touches a page.** This was the plan's fourth wrong assumption and it is worth writing down: `PRAGMA key` returns `ok` for **any** key, correct or not, because SQLCipher has not read a page yet. Without a deliberate probe the wrong-key error fires on the _next_ statement, which is `journal_mode = WAL` — so the operator's evidence for a wrong key is an error about journalling. `assertDatabaseOpens` runs `SELECT count(*) FROM sqlite_master` first, and its `catch` has exactly one exit: a `throw`.
3. **The message names the mistake instead of quoting SQLite.** All four ways this can go wrong arrive as the same `SQLITE_NOTADB`, "file is not a database" — a sentence that reads as corruption and invites exactly the wrong reflex. `describeFailure` looks at the file's first sixteen bytes rather than guessing from the error, and answers one of four ways: a plain file with no key set (not an encryption problem at all — restore); a plain file with a key set (unset it, or encrypt first); a non-plain file with no key set (**two readings the bytes cannot distinguish** — encrypted and intact, or never encrypted and damaged — and it says which is likelier on a deployment where the key has never been set); or a non-plain file with the wrong key. Three of the four end with "the data is still there and untouched", and all four end with `REFUSING`, which spells out that continuing would seed an administrator and print a password.

## The pragma order is load-bearing, and nothing pinned it

```js
db.pragma("cipher=sqlcipher");
db.pragma(keyPragma(key));
```

**These two lines must not be swapped.** `cipher` selects the scheme; `key` is interpreted by whichever scheme is selected at the moment it is set — and this driver's default is **chacha20**, not sqlcipher. Key-first writes a chacha20 database, and the later `cipher=sqlcipher` does not convert it. A reorder therefore silently changes the **on-disk format**: every existing encrypted database stops opening, and the operator is told "LAWHA_DB_KEY does not decrypt this database" — the exact panic this half exists to prevent.

Swapping the lines left **all 19 tests green**. Write and read share the same code path, so the whole suite agreed with itself about a format nothing else in the world would agree with. Two tests were added that open the file back through a **raw** driver handle rather than through `openDatabase`: one with an explicit `cipher=sqlcipher` which must succeed, one key-only which must throw. With those, the swap gives `2 failed | 19 passed` — exactly the two new tests, confirming nothing pre-existing can see the difference. `backupVerifyParity.test.ts` now also asserts that every file setting both pragmas sets `cipher=` before any `key=`/`rekey=`.

This is the general shape of the lesson roadmap §4 already states — assert on the artefact, not on a proxy for it. Here the artefact is the byte format, and the only way to interrogate it was to stop using the code under test to read it.

## Two things the spec called for that do not exist

**`sqlcipher_export` is absent** from `better-sqlite3-multiple-ciphers` 12.11.1 (SQLite3 Multiple Ciphers 2.3.5). It answers `no such function`. Its `pragma_function_list` contains `sqlite3mc_codec_data`, `sqlite3mc_config` and `sqlite3mc_version` and no export function at all. `ATTACH DATABASE … KEY …` does work and does produce a genuinely sqlcipher-encrypted file, but without `sqlcipher_export` the schema and every row would have to be copied by hand — rewriting each `CREATE …` in `sqlite_master` to name the attached schema. Hand-rolled DDL surgery is the wrong thing to put in the one command that can lose every board, which is precisely why `sqlcipher_export` exists upstream.

What replaced it copies more faithfully, not less. `encrypt-db.mjs` uses `db.backup()` plain-to-plain into a staging file and then rekeys the copy in place: page for page, so indexes, views, triggers, `user_version` and `sqlite_sequence` come across because nothing is being re-created. Review did not take that list on faith — a fixture with a partial unique index, a view, a trigger, `AUTOINCREMENT`, a `WITHOUT ROWID` table and `user_version=4242` was built, and after encryption the trigger still fired and the partial unique index still raised `SQLITE_CONSTRAINT_UNIQUE`.

**`PRAGMA rekey` is refused outright in WAL mode** — "Rekeying is not supported in WAL journal mode". So the staging copy is put into `journal_mode = DELETE` first, which also means the file that gets installed arrives with no sidecars of its own. The server sets WAL again on its next open.

## `PRAGMA rekey` silently destroys a 512-byte-page database

Measured across every power of two from 512 to 65536. **512 is the only failure, and it fails silently**: the pragma reports `ok`, the header is rewritten so the file looks encrypted, and the result is something the **correct** key cannot open. If that ever reached `lawha.db`, it would be a total, unrecoverable loss with a success message attached.

The live database's `page_size` is **4096** — verified independently, read-only, twice — so it is not affected. The guard exists anyway: `encrypt-db.mjs` refuses a page size under 1024 by name, up front, and verifies the encrypted copy afterwards regardless, because refusing by name only ever covers the cause already known.

(SQLite requires at least 480 usable bytes per page and SQLCipher reserves part of every page for its IV and HMAC, which is the obvious explanation. That is inference, not something read out of the C, and it is written down as inference.)

## What Half B costs, measured

**Opening a connection: 0.076 ms → 82.9 ms.** That is PBKDF2-HMAC-SHA512 stretching the passphrase, and it is roughly a **1100×** increase. It is survivable for exactly one reason: **nothing in this server opens a connection per request.** That was verified from source rather than assumed — `openDatabase` has two callers, `src/context.ts:66` (once, from `index.ts`) and the migrate CLI. 83 ms is a boot cost. If a future change ever opens a connection inside a handler, this number becomes a latency budget and this paragraph becomes the reason it was not noticed.

**Reads: 0.55 ms → 8.23 ms over 3.91 MB, about 15× slower.** Per-page crypto on every read, as expected.

Two earlier benchmark runs were **wrong** and are kept on the record rather than discarded: one was distorted by CPU frequency scaling, the other by a warm page cache that meant the cipher was never called at all. "AES is fast" and "this is fine" are different claims and the first one is not evidence for the second.

**The `-wal` and `-shm` sidecars carry no plaintext**, and this was checked by grepping the bytes rather than by trusting the documentation — by two people, with independently chosen needles. The plaintext control was stark: the main file is a 4096-byte header while the `-wal` held 523 KB carrying a username five times and a board name nine. Encrypted: zero hits in `.db`, `-wal` or `-shm`.

## The SQLite engine moves for everyone, key or no key

`src/db/index.ts` now links `better-sqlite3-multiple-ciphers` **unconditionally**, and so do `lib/backupSnapshot.ts` and `lib/backupVerify.ts`. That takes the SQLite serving traffic from **3.47.0 to 3.53.2 on the next image rebuild, for every deployment, whether or not `LAWHA_DB_KEY` is ever set.**

So "an existing deployment is unchanged until it opts in" is slightly stronger than what is true. It is unchanged in _behaviour_ and in _file format_; the engine underneath it is a different version. That is stated here because it is the kind of claim that is repeated until somebody debugs against it.

The unconditional link was a choice, and it closed a real hazard. While two SQLite libraries were linked into one process they did not share lock state — the WAL protocol assumes one library arbitrating every connection to a file. Measured: with the encrypted connection open and 3 MB in the `-wal`, an **in-process** plain `new Database(livePath)` threw `SQLITE_NOTADB` and, on the way out, checkpointed the WAL away and deleted **both sidecars** underneath the live connection.

```
before: main 4096 · -wal 3003512 · -shm 32768
after:  main 217088 · -wal absent · -shm absent
```

It was latent rather than live — the two plain call sites only ever opened snapshot and archive files — but it was one call site away from real. The existing rule for `backupTar.ts` ("do not add a third caller that passes `ctx.config.dbPath`") now has a second and sharper reason: importing plain `better-sqlite3` anywhere under `src/` re-creates the hazard, and an in-process plain open of the live database does not merely fail, it destroys the sidecars of the connection serving traffic.

`scripts/backup.mjs`, `scripts/restore.mjs` and `scripts/encrypt-db.mjs` still link plain `better-sqlite3` alongside the cipher driver, and that is safe for a different reason: they run in a **separate process**, where SQLite's cross-process locking does apply. Re-run that way, every file was byte-identical.

## Migrating the live database

`encrypt-db.mjs` is the one operation in this project that can lose every board at once, and the whole file is shaped around that. **Nothing in it deletes a database.** The plaintext original is renamed to `<db>.pre-encryption` and left on disk; removing it is the operator's decision, by hand, afterwards. That is the same discipline `restore.mjs` uses, for the same reason: the procedure that once cost this deployment its accounts began by deleting the live data before anything had been proven about what was replacing it.

The order is the point: refuse before touching anything (no key, a key the server itself would not boot with, a missing file, a `.pre-encryption` already in the way, a file that is not plaintext SQLite, a page size under 1024) → prove nobody else has it open with an exclusive lock, then checkpoint → count every table and record the schema → copy to a staging file beside the database, never onto `lawha.db` → encrypt the **copy** in place → verify it on a fresh connection opened exactly the way `src/db/index.ts` opens the live database, comparing schema and per-table counts, and **refuse outright on any mismatch** with the original still in place → move the original aside, install with one atomic rename, and verify again from `lawha.db` itself, because "the copy is good" and "the copy is what landed" are different claims.

**The answer to "what is the worst that can happen against the real database" is: nothing worse than the original surviving at `.pre-encryption`.** That is not an assurance, it is a measurement. Review copied the live database with its 350232-byte `-wal` and 32768-byte `-shm`, nothing pre-opened, and ran the script: every row of all 15 tables SHA-256 identical, `sqlite_master` byte-identical (16 tables, 30 indexes), `integrity_check` ok, `foreign_key_check` empty, and `openDatabase({key})` read it. 100 randomized kills (60 SIGKILL / 40 SIGTERM) on a 55 MB database produced **zero** broken states. Only a SIGKILL at the exact rename instant removes `lawha.db` — and both a complete plaintext aside and a verified ciphertext are sitting beside it when it does, with a run afterwards naming both files and printing the `mv` that fixes it.

**The dangerous window has no yield point,** and that is the property that matters rather than its length. A JS signal handler only runs once the current synchronous stretch finishes, so a signal arriving between the move-aside and the install is queued until after the window has closed. A test asserts there is no `await` between those two lines, and review could not enter the window even by raising SIGTERM from inside the `rename()` syscall itself with `LD_PRELOAD`.

**The procedure, from the reviewer who ran it against a copy of the real database:**

1. Stop the stack. A forgotten stack costs only a message — the refusal was verified to leave the sidecars byte-identical.
2. **Pass `LAWHA_DB_PATH` explicitly.** The default is `./lawha-data/lawha.db`, which does not exist on this machine.
3. **Expect `lawha.db` to shrink.** In the measured run, 770048 → 598016 bytes: `freelist_count` 43 → 0, `page_count` 188 → 146. That is compaction, not loss, and it is the number most likely to be misread as a disaster.
4. **Keep `lawha.db.pre-encryption` until the server has started, the boards have been seen, and a backup has been proven** — all three, not the first two.

One escaping detail is worth recording because the obvious reading of it was wrong. The key is interpolated into a SQL string literal (`pragma()` has nowhere to bind a parameter), so `'` is doubled. The dangerous mutation is **not** a bare unquoted key: that dies at the rekey with `unrecognized token`, exit 1, original byte-identical. The dangerous one is the edit that **strips** quotes instead of doubling them — it exits 0, prints a normal success report, and produces a file the correctly-escaped key cannot open. Both are caught now, because the test helper does its own independent escaping rather than reusing the code under test.

## `lawha.env` reaches the containers only — the most reachable mistake this feature creates

`lawha.env` is loaded by compose's `env_file:` into `lawha-server` and `lawha-backup`. It reaches **nothing on the host.**

So the scheduled backup has `LAWHA_DB_KEY` and keeps working, and the `/admin` download has it and keeps working. **A backup or restore run by hand on the host does not** — and `docs/backups.md` documents host-run backup as the normal way to do it:

```bash
LAWHA_DB_PATH=~/lawha-data/lawha.db corepack yarn --cwd lawha-server backup ~/lawha-backups
```

On a keyed deployment that refuses by name rather than doing anything silent, which is the right behaviour and still an unpleasant surprise on the day somebody needs a restore. The fix is one `export`, and it belongs in the operator's head before they turn the setting on, not in a stack trace afterwards. `lawha.env.example` says so beside both settings, and `docs/backups.md` beside both commands.

`restore.mjs` also **refuses** rather than converting when it is handed a plaintext artefact while `LAWHA_DB_KEY` is set — the reachable case of restoring a pre-encryption backup into a deployment that has since opted in. Installing it would leave a database the server refuses to boot against, discovered on the next `docker compose up` with the live database already moved aside. Converting it inline would mean a second, thinner copy of `encrypt-db.mjs` inside the one script that must not be clever. So it prints the two-command recipe: restore with the key unset, then `encrypt-db`.

## Consequences

- **Two new settings, both opt-in, both off here.** `LAWHA_BACKUP_RECIPIENT` (an `age1…` public key, shape-validated at config load) and `LAWHA_DB_KEY` (minimum 16 characters, a floor to catch `changeme`, not a certification — SQLCipher's PBKDF2 makes the passphrase the whole of the strength). Both documented in `lawha.env.example` with an `IF WRONG` note, and in `docs/configuration.md` with the migration procedure and the key-loss warning beside them.
- **`lawha-server/Dockerfile` gains `age`** in the runtime stage only, and `lawha-server` gains `better-sqlite3-multiple-ciphers` 12.11.1 as a production dependency. Plain `better-sqlite3` stays for `scripts/`, which run in their own processes.
- **`scripts/encrypt-db.mjs` is new**, wired as `yarn --cwd lawha-server encrypt-db`, and is the only supported way to convert an existing database.
- **`--encrypt-existing-blobs` is new** on `docker/lawha-backup.sh`, operator-invoked only, and is **required** after setting a recipient on a deployment that already has a blob mirror.
- **A keyed `/admin` "Back up now" stalls the event loop** for the duration of the copy, because `VACUUM INTO` does not yield. Unkeyed is unchanged and pinned by a test.
- ~~**The `/admin` listing flags the `age` key only.** A keyed deployment's tars need `LAWHA_DB_KEY` and the panel does not say so.~~ **False since `a3485bb1`, which is 25 minutes after this file was committed.** See Amendments.
- **`age` was never exercised on this machine.** It is not installed here, so every `age` round-trip test in the suite skips — as they have since Task 3. Review reproduced the full round trip independently from `age-keygen` up, with per-table counts and row contents matching and the installed file byte-identical to a plain `age -d`, plus an adversarial matrix (truncated `.age`, wrong key, unrelated key, `age` absent, garbage plaintext, live server, stdin identity) that left the database intact every time. But **the keyed-plus-`age` combination is structurally sound and unexercised**, and that is the honest statement.
- **Out of scope, deliberately:** key rotation for either key (a real piece of work, and a separate one), hardware-backed key storage, and anything in transit — that is TLS, and ADR 0018's 2026-08-06 amendment is where it is written down. Encrypting the database does nothing about a session cookie crossing the LAN in the clear, and the two should not be confused for one another.

## Amendments

### Same day, 2026-08-07 — the `/admin` listing names both keys

The section "The `/admin` download, and what it still does not say" and the Consequences bullet quoted from it described a gap that `a3485bb1` closed **twenty-five minutes after `20222dee` wrote this file**. Amended rather than edited away, because the shape of the mistake is the point: an ADR that says "recorded here rather than fixed" is making a claim about the future, and the future in this repository is sometimes half an hour long. The audit of 2026-08-12 (finding 11) found both passages still asserting it.

`backupArchive.ts:55` now declares **`needsDatabaseKey`** beside `needsPrivateKey`, and it is answered per entry from **the artefact's own first sixteen bytes** rather than from what the deployment is configured with today — an archive spans the day the key was turned on, and the entries either side of it differ with nothing in the filename to say which is which. The one shape that cannot be answered honestly is `.db.age`: this process holds no age private key by design, so that case falls back to the current config, over-warning for old artefacts and never under-warning for one that needs it. Same fail-safe direction as `hasAnyEncryptedBlob`, and pinned so it cannot be flipped.

`LawhaAdminBackup.tsx` renders three badge variants from the pair, and branches the download hint on `databaseEncrypted` — which is a different question from the listing's, being about this server now rather than about the archive. The hint it replaced said a keyed deployment's download was "in plain form", which was not incomplete but affirmatively wrong.

The narrow sub-clause that survives, and is still exactly true, is that **`needsPrivateKey` covers the `age` key only**. That was never the defect; the defect was that nothing covered the other key.

### 2026-08-07 — the outage this feature caused on the way in, and the invariant that came out of it

Half B took the running deployment's backups down for the afternoon, and the mechanism is worth an ADR line even though the code now carries a thirty-line warning about it.

`docker-compose.yml` bind-mounts `./lawha-server/scripts` into `lawha-backup` **read-only**. Those two files — `backup.mjs` and `restore.mjs` — are therefore the only part of the running stack served from the working tree rather than from an image, while their `node_modules` comes from the image. `7e8f1848` added a **top-level** `import … from "better-sqlite3-multiple-ciphers"` to both. The running image predates the commit that added that dependency, so the edit went live at the moment it was saved, with no build, no restart and nothing to review it.

An ESM top-level import resolves **before the module body runs**, so the failure preceded argument parsing, `--help`, and every careful refusal in the file:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3-multiple-ciphers'
```

A deployment that had **never set `LAWHA_DB_KEY`** — which is this one — lost its six-hourly backup and, because `restore.mjs` carried the same line, its recovery path, at the same instant, for a feature it had not enabled.

`96ef45d7` moved both loads to a dynamic `await import()` inside the `dbKey !== null` branch. That is the same rule `backupSnapshot.ts` already stated for the event loop — a deployment that never set the key should not pay for the feature — applied to the dependency, which is the more expensive half. When the driver genuinely is needed and genuinely is absent, the failure now names `docker compose build`.

**The invariant, stated so it is not relearned:** anything under `lawha-server/scripts/` is live in `lawha-backup` the instant it is written, and its dependencies are the image's, not the tree's. A new top-level import there is a deployment. The tests pin the property rather than the instance — `stageWithoutCipherDriver` builds a tree that mirrors the container, with `better-sqlite3` symlinked and the cipher driver genuinely unresolvable — and a mutation test puts the top-level import back and asserts it dies, so the three passing tests cannot go vacuous if the isolation ever stops isolating.

### 2026-08-12 — `LAWHA_DB_KEY` in the archive, said out loud at start-up

The `config/` mirror section above gained the paragraph naming `LAWHA_DB_KEY` among the secrets that copy carries. `docker/lawha-backup.sh` now also **says so at start-up**, once, in the one combination where it matters — a key set and no recipient — immediately after the existing `db key …` line it elaborates. It names the three settings and the path, and never prints the key: a warning that echoed the value into `docker compose logs` would be this same finding again with a wider audience than the archive it is complaining about.

It sits below the `INTERVAL_HOURS=0` branch on purpose, so a deliberately disabled scheduler stays silent — it never mirrors config, so it has no copy in the archive to warn about.

Reproduced against a fixture config before it was written: `backups/config/lawha.env` line 3 was the SQLCipher key, mode 0600, beside the ciphertext it opens. Two things that bound how bad it is, and neither of them is a reason not to say it: `mirror_offsite` uses `cp -an`, and `-n` is no-clobber, so on an established off-site mirror the key does not propagate; and the `/admin` download tar contains only the database and `files/`, never `config/`, so "a tar handed to somebody who needed the boards and not the credentials" — the phrase Half B's own justification uses — still works.
