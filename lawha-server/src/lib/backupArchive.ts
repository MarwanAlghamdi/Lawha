import fs from "node:fs";
import path from "node:path";

import { AGE_BACKUP_NAME, BACKUP_NAME } from "./backupVerify.js";

import type { LawhaContext } from "../context.js";

/**
 * Reading the `lawha-backup` container's archive, from the outside.
 *
 * Everything here is read-only, and not by convention — the mount itself is
 * `:ro` in docker-compose.yml. That is the security boundary this whole
 * feature was shaped around: the network-facing process may show an operator
 * what backups exist and hand one back, and may not create, alter or delete
 * one. Writing belongs to the backup container, which listens on nothing.
 */

/** One entry as the admin panel sees it. */
export interface ArchiveEntry {
  id: string;
  takenAtMs: number;
  sizeBytes: number;
  /**
   * Whether OPENING THIS DOWNLOAD needs the private key — not merely
   * whether this entry's own `.db`/`.db.age` file does. Review found the
   * naive `id.endsWith(".db.age")` check the client used to make itself
   * unsafe in exactly the direction that matters: `resolveArchiveBlobsDir`
   * bundles every archive download with the SAME shared `files/` mirror
   * (there is one per archive, not one per entry), so the instant that
   * mirror holds even a single `.age` blob, EVERY entry's tar — including
   * an older, still-plaintext `.db` — carries ciphertext the id alone gives
   * no hint of. Computed here, once per listing, so the client never has to
   * reconstruct this reasoning (or get it wrong) itself.
   */
  needsPrivateKey: boolean;
  /**
   * Whether opening the DATABASE inside this download needs `LAWHA_DB_KEY` —
   * a different key, protecting a different thing, from `needsPrivateKey`
   * above. That one is the `age` identity that unwraps the archive; this one
   * is the SQLCipher key the server itself boots with, and a download can
   * need either, both, or neither.
   *
   * Answered from the ENTRY'S OWN BYTES wherever that is possible: SQLCipher
   * encrypts the header, so sixteen bytes settle it for a plain `.db`, per
   * artefact and with no guessing. That matters because an archive spans the
   * migration — the backups taken before `LAWHA_DB_KEY` was set are plaintext
   * and sitting in the same directory as the ones taken after it.
   *
   * A `.db.age` entry is the one case that cannot be answered honestly: this
   * process holds no `age` private key (by design — that is the whole of Half
   * A) so it cannot see what is inside. It falls back to whether this
   * deployment is keyed TODAY, which over-warns for artefacts predating the
   * key and never under-warns for one that needs it. Same fail-safe direction
   * as `hasAnyEncryptedBlob` below, for the same reason.
   */
  needsDatabaseKey: boolean;
}

/** The scheduler's own account of itself, from `.lawha-backup-status`. */
export interface BackupStatus {
  configured: boolean;
  status: string | null;
  at: number | null;
  atLocal: string | null;
  intervalHours: number | null;
  keep: number | null;
  detail: string | null;
  /**
   * Whether this server's database is SQLCipher-encrypted (`LAWHA_DB_KEY`).
   *
   * Not part of the scheduler's own status file, and deliberately answered
   * here from this process's own config instead: it is a fact about what the
   * `/admin` "back up now" button will produce RIGHT NOW, taken in this
   * process from this connection, and the panel was stating the opposite of
   * it in prose. Reported for an unconfigured archive too, because the
   * on-demand snapshot exists whether or not a scheduler does.
   */
  databaseEncrypted: boolean;
  /**
   * Whether the scheduler's own status line is older than it is allowed to
   * be — the SAME judgement `lawha-backup.sh --health` makes about the same
   * file, moved here so the two readers genuinely cannot disagree.
   *
   * They could, and did. This reader reported `status=` verbatim while
   * `--health` applied `interval_hours*3600 + grace` to `at=`, so a
   * seven-day-old `status=ok` — a scheduler container an operator stopped, or
   * one wedged on a child that never returns — made `docker compose ps` red
   * and left `/admin` saying "Running normally" with the raw timestamp sitting
   * right beside it and nothing to say it was late.
   *
   * `status` is still reported verbatim. This is an EXTRA field, not a
   * rewrite of that one: a stalled scheduler's last completed cycle really
   * did succeed, and the panel needs both halves to say "the last backup
   * worked, and there has not been one since".
   */
  overdue: boolean;
  /**
   * The age limit `overdue` was decided against, in milliseconds, or null
   * where no honest limit exists (see `readBackupStatus`). Exposed so the
   * panel can name the threshold instead of re-deriving it from
   * `intervalHours` and getting the grace wrong — which is the same class of
   * bug this field exists to close.
   */
  overdueAfterMs: number | null;
}

const STATUS_FILE_NAME = ".lawha-backup-status";

/**
 * How late a status line may be before this is called a stall.
 *
 * ONE HOUR, and it is `OVERDUE_GRACE_SECONDS` in `docker/lawha-backup.sh`
 * spelled in the units this side works in. A second copy of a constant is
 * normally the bug — see `backupVerify.ts`'s header on why `COUNTED_TABLES`
 * is duplicated and what holds the copies together — and the same answer
 * applies: the script cannot be imported (it is bash, in another container),
 * so `tests/integration/backupCoverage.test.ts` read it as text and failed if
 * these two numbers stopped matching. **That test went with `59930dbf` and
 * nothing replaced it.** The two numbers agree today; if you change either,
 * change the other in the same commit, because no gate will tell you.
 *
 * The script's own comment carries why an hour: it absorbs a long-running
 * backup and a host that was asleep, without absorbing a scheduler that has
 * stopped.
 */
export const OVERDUE_GRACE_MS = 60 * 60 * 1000;

/**
 * The states `--health` applies the staleness rule to.
 *
 * `ok` refreshes every `INTERVAL_HOURS` and `waiting` every `WAIT_SECONDS`,
 * so one rule covers both: a line older than the interval plus the grace
 * means the loop that writes it has stopped. The two it deliberately leaves
 * out are `disabled` — off on purpose is not broken, and reporting it as
 * broken teaches an operator to ignore this signal — and `failed`, which is
 * already the loudest thing the card can say and does not need a second
 * sentence about the same cycle.
 */
const STALENESS_JUDGED = new Set(["ok", "waiting"]);

/** Where the blob mirror lives inside the archive, when LAWHA_BACKUP_FILES is on. */
const ARCHIVE_BLOBS_DIR_NAME = "files";

/**
 * The archive-shaped half of "nothing to report". `databaseEncrypted` is
 * `false` here only as a placeholder — every return path below overrides it
 * from `ctx`, because it is a fact about the server rather than about the
 * archive and is true or false whether or not a scheduler exists.
 */
export const NOT_CONFIGURED: BackupStatus = {
  configured: false,
  status: null,
  at: null,
  atLocal: null,
  intervalHours: null,
  keep: null,
  detail: null,
  databaseEncrypted: false,
  overdue: false,
  overdueAfterMs: null,
};

/**
 * The first sixteen bytes of every unencrypted SQLite file — same constant,
 * same reasoning, as `SQLITE_MAGIC` in `src/db/index.ts`, where the NUL is
 * written `\0` so git does not read the file as binary.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Does this artefact open without `LAWHA_DB_KEY`?
 *
 * Sixteen bytes off the front, never an open: this runs once per entry on
 * every admin page load, and a file the retention container may delete
 * underneath us is not something to hold a database handle to. Fails in the
 * "needs the key" direction on any read error, which is the same fail-safe
 * direction the rest of this file takes — a badge shown once too often costs
 * nothing; one missing costs somebody a file they cannot open and no
 * explanation.
 */
const isPlaintextSqlite = (file: string): boolean => {
  let handle: number | undefined;
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
 * Turn a client-supplied entry id into an absolute path, or refuse.
 *
 * Two independent checks, because one of them is not enough and the cheap one
 * is not the one that would survive a mistake. First the name must match
 * `BACKUP_NAME` or `AGE_BACKUP_NAME` exactly — both anchored, no separators in
 * either character class, so `../`, an absolute path and a nested path all
 * fail before touching the disk. Then the resolved path must still sit inside
 * the archive directory, which catches anything the regex was wrong about,
 * including a symlinked archive root.
 *
 * Accepting the SECOND pattern here is widening what counts as a valid id, not
 * widening what an id may CONTAIN — `AGE_BACKUP_NAME` is exactly as strict as
 * `BACKUP_NAME` (a fixed-width timestamp, a literal suffix, nothing else), so
 * this still rejects everything it rejected before and only additionally
 * accepts `lawha-<stamp>.db.age`.
 *
 * Same belt-and-braces shape as `resolveFilePath` in http/routes/files.ts, and
 * for the same reason: a path built from client input is a path traversal
 * until proven otherwise.
 */
export const resolveArchiveEntryPath = (
  ctx: LawhaContext,
  entryId: string,
): string | null => {
  const archiveDir = ctx.config.backupArchiveDir;

  if (
    !archiveDir ||
    !(BACKUP_NAME.test(entryId) || AGE_BACKUP_NAME.test(entryId))
  ) {
    return null;
  }

  const resolved = path.resolve(archiveDir, entryId);

  if (
    resolved !== path.join(archiveDir, entryId) ||
    !resolved.startsWith(archiveDir + path.sep)
  ) {
    return null;
  }

  return resolved;
};

/**
 * Does `dir` hold at least one `age`-encrypted blob, anywhere in its tree?
 *
 * Short-circuits on the first match — this only needs a yes/no answer, not
 * a count, and a mirror can hold thousands of files by the time an operator
 * has been running a deployment for a while. Fails closed in the SAFE
 * direction on a read error: unlike `listArchiveEntries`'s own `readdirSync`
 * (where "cannot read" correctly means "report nothing"), a mirror this
 * function cannot fully walk must not be reported as "definitely no
 * ciphertext in here" — an unreadable subtree is treated as "assume yes"
 * so a listing failure can only make the private-key warning appear too
 * often, never make it wrongly disappear.
 */
const hasAnyEncryptedBlob = (dir: string): boolean => {
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];

    try {
      entries = fs.readdirSync(current);
    } catch {
      // Could not walk this subtree — see the header comment above: assume
      // the worst (ciphertext might be in there) rather than the safest-
      // looking answer, which here is the wrong one.
      return true;
    }

    for (const name of entries) {
      const full = path.join(current, name);
      let stats: fs.Stats;

      try {
        stats = fs.statSync(full);
      } catch {
        return true;
      }

      if (stats.isDirectory()) {
        stack.push(full);
      } else if (stats.isFile() && name.endsWith(".age")) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Newest first. Anything that is not a verified-looking backup name is skipped
 * — `.partial` copies mid-write, `.rejected` ones that failed verification,
 * the status file, the blob mirror. `backup.mjs` renames a rejected artefact
 * out of the `lawha-*.db`/`lawha-*.db.age` namespace precisely so readers like
 * this one ignore it, and a corrupt file that still looks downloadable is
 * worse than no file.
 *
 * Both `BACKUP_NAME` and `AGE_BACKUP_NAME` are checked — an encrypted archive
 * is still an archive. Missing the second form here does not corrupt
 * anything, but it is its own quiet failure: `LAWHA_BACKUP_RECIPIENT` set, the
 * directory filling with good `.db.age` artefacts, and this panel reporting
 * zero of them forever, with no error anywhere to say why.
 *
 * The timestamp comes from mtime rather than from parsing the name, matching
 * what `lawha-backup.sh` does for its own scheduling: an mtime is absolute and
 * means the same thing in every timezone, where the name is stamped in the
 * backup container's local time.
 */
export const listArchiveEntries = (ctx: LawhaContext): ArchiveEntry[] => {
  const archiveDir = ctx.config.backupArchiveDir;

  if (!archiveDir) {
    return [];
  }

  let names: string[];

  try {
    names = fs.readdirSync(archiveDir);
  } catch {
    // Configured but unreadable — the mount is missing, or the archive has not
    // been created yet. An empty list is the honest answer; the status card
    // above it is what explains why.
    return [];
  }

  /**
   * Computed ONCE per listing, not per entry — every entry in this archive
   * shares the same `files/` mirror (see `resolveArchiveBlobsDir`), so
   * whether ciphertext is in it is one fact about the archive, not N facts
   * about its entries.
   *
   * Only walked when the mirror actually exists (`mirrored === true`):
   * the live `LAWHA_FILES_DIR` fallback can structurally never contain an
   * `.age` file — nothing ever writes one there, only `mirror_blobs` and
   * `encrypt_existing_blobs` do, and both write exclusively into the
   * archive's own mirror — so walking it in the unmirrored case would cost
   * a full pass over a potentially large live directory on every admin page
   * load for an answer already known to be "no" by construction.
   */
  const blobs = resolveArchiveBlobsDir(ctx);
  const blobsHaveCiphertext = blobs.mirrored && hasAnyEncryptedBlob(blobs.dir);

  const entries: ArchiveEntry[] = [];

  for (const name of names) {
    if (!BACKUP_NAME.test(name) && !AGE_BACKUP_NAME.test(name)) {
      continue;
    }

    try {
      const stats = fs.statSync(path.join(archiveDir, name));

      if (stats.isFile()) {
        const wrappedInAge = AGE_BACKUP_NAME.test(name);

        entries.push({
          id: name,
          takenAtMs: stats.mtimeMs,
          sizeBytes: stats.size,
          needsPrivateKey: wrappedInAge || blobsHaveCiphertext,
          // See the field's own comment: the bytes settle it for a plain
          // `.db`, and only a `.db.age` — whose interior nothing here can
          // read — falls back to what this deployment is configured with.
          needsDatabaseKey: wrappedInAge
            ? ctx.config.dbKey !== null
            : !isPlaintextSqlite(path.join(archiveDir, name)),
        });
      }
    } catch {
      // Pruned between readdir and stat — retention runs in another container
      // and does not wait for us. Skipping is correct; it is genuinely gone.
      continue;
    }
  }

  return entries.sort((a, b) => b.takenAtMs - a.takenAtMs);
};

/**
 * Which directory of blobs belongs with an archived database.
 *
 * The mirror, when it exists, and the live files directory only as a fallback.
 * That order matters and is not arbitrary: the mirror is append-only and never
 * deletes, so it still holds blobs that an old backup references and that the
 * live deployment has since removed — `auth.ts` unlinks a board's blob
 * directory when the board or its owner goes. Restoring a three-month-old
 * database against today's live blobs would silently produce boards with
 * missing images.
 *
 * The fallback exists for `LAWHA_BACKUP_FILES=false`, where an operator has
 * opted out of mirroring. It is the best available answer, not an equivalent
 * one, and the caller records which was used.
 */
export const resolveArchiveBlobsDir = (
  ctx: LawhaContext,
): { dir: string; mirrored: boolean } => {
  const archiveDir = ctx.config.backupArchiveDir;

  if (archiveDir) {
    const mirror = path.join(archiveDir, ARCHIVE_BLOBS_DIR_NAME);

    try {
      if (fs.statSync(mirror).isDirectory()) {
        return { dir: mirror, mirrored: true };
      }
    } catch {
      // Not mirrored. Fall through.
    }
  }

  return { dir: ctx.config.filesDir, mirrored: false };
};

/**
 * Parse `.lawha-backup-status`, the file the scheduler writes every cycle and
 * its own HEALTHCHECK reads.
 *
 * Reading the scheduler's file rather than recomputing the answer here is the
 * point: `docker compose ps` and `/admin` then cannot disagree about whether
 * backups are healthy, because there is one writer and two readers. Plain
 * `key=value` lines, written through a temp file and renamed, so a read that
 * races a write gets the old status or the new one and never half a line.
 *
 * That claim used to be false, and this is where it was false. One writer and
 * two readers guarantees nothing on its own if the two readers apply different
 * RULES to what they read — `--health` refused a status line older than
 * `interval_hours*3600 + grace` while this function passed the same line
 * through untouched, and the disagreement was a card reading "Running
 * normally" beside a container `docker compose ps` was already calling
 * unhealthy. The rule now lives here too, as `overdue`. `backupCoverage.test.ts`
 * used to pin the two constants together; it went with `59930dbf`, so this
 * copy is held by review alone — see the `OVERDUE_GRACE_MS` header above.
 */
export const readBackupStatus = (ctx: LawhaContext): BackupStatus => {
  const archiveDir = ctx.config.backupArchiveDir;

  const databaseEncrypted = ctx.config.dbKey !== null;

  if (!archiveDir) {
    return { ...NOT_CONFIGURED, databaseEncrypted };
  }

  let raw: string;

  try {
    raw = fs.readFileSync(path.join(archiveDir, STATUS_FILE_NAME), "utf8");
  } catch {
    // Configured, but the scheduler has not completed a cycle yet — a stack
    // that came up sixty seconds ago looks exactly like this. Configured with
    // everything else null says "we are waiting", which is true.
    return { ...NOT_CONFIGURED, configured: true, databaseEncrypted };
  }

  const fields = new Map<string, string>();

  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");

    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  const number = (key: string): number | null => {
    const value = fields.get(key);

    if (value === undefined || value === "") {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  // The file records seconds since epoch; everything on the client side of
  // this app works in milliseconds, and so does the comparison below.
  const seconds = number("at");
  const at = seconds === null ? null : seconds * 1000;
  const intervalHours = number("interval_hours");
  const status = fields.get("status") ?? null;

  /**
   * The limit, or null where there is no honest one to state.
   *
   * Three ways to reach null, and each is a refusal to guess rather than an
   * oversight. A state outside `STALENESS_JUDGED` is not judged by age at
   * all. A missing `at=` leaves nothing to measure. A missing
   * `interval_hours=` means a file this deployment's scheduler did not
   * write — `write_status` emits it every cycle — and defaulting to
   * twenty-four hours there would be this very finding again, pointing the
   * other way: a made-up threshold quietly disagreeing with the one
   * `--health` reads out of its own environment.
   */
  const overdueAfterMs =
    status !== null &&
    STALENESS_JUDGED.has(status) &&
    at !== null &&
    intervalHours !== null
      ? intervalHours * 60 * 60 * 1000 + OVERDUE_GRACE_MS
      : null;

  return {
    configured: true,
    databaseEncrypted,
    status,
    at,
    overdueAfterMs,
    overdue:
      at !== null &&
      overdueAfterMs !== null &&
      Date.now() - at > overdueAfterMs,
    atLocal: fields.get("at_local") ?? null,
    intervalHours,
    keep: number("keep"),
    detail: fields.get("detail") || null,
  };
};
