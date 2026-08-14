import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

import { verifyBackupFile } from "./backupVerify.js";

import type { LawhaContext } from "../context.js";

/**
 * A backup taken on demand, in this process, for immediate download.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. Never `cp` or `tar` `lawha.db`
 * directly. It is true, it is not theoretical — this deployment lost its
 * accounts to exactly that once — and this file appears to violate it, because
 * what it produces is handed to `tar` a moment later.
 *
 * It does not violate it. The rule is about the LIVE database, which runs in
 * WAL mode and is a 4KB header plus a multi-megabyte `-wal` sidecar; copying
 * that file alone yields a database with zero tables that restores in silence.
 * What gets tarred here is never that file. It is a copy made through SQLite's
 * online backup API, which walks the pages under a read lock and produces a
 * complete database, and which is then forced to `journal_mode = DELETE` so it
 * has no sidecars left to lose. That artefact is a plain, standalone,
 * self-contained file, and tarring it is safe.
 *
 * `scripts/backup.mjs` does the same three things in the same order for the
 * scheduled backups. If you find yourself removing the pragma below because it
 * "does nothing", read that script's comment on the same line first.
 *
 * WITH `LAWHA_DB_KEY` SET the copy is made a different way, and the reason is
 * that the obvious way does not work: `ctx.db.backup()` across a SQLCipher
 * source and the plain destination the online backup API creates for itself
 * answers "backup is not supported with incompatible source and target
 * databases" — measured, and it is why this whole path was unusable the day
 * Task 6 shipped. It failed LOUDLY, which is the good half; nothing ever wrote
 * a plaintext copy of an encrypted database.
 *
 * `VACUUM INTO` is what replaces it, and SQLite3 Multiple Ciphers carries the
 * source's cipher and key across to the target — measured against this exact
 * driver: the artefact's header is not `SQLite format 3`, it opens with
 * `LAWHA_DB_KEY` and refuses any other key, its `integrity_check` is `ok`, and
 * it arrives in `journal_mode = delete` with no sidecars, which is the same
 * single-file property the plain path's pragma below has to ask for. It is a
 * consistent read of the whole database including whatever is still in the
 * `-wal`, so the WAL hazard this file's header is about is answered the same
 * way `db.backup()` answers it.
 *
 * The cost, stated rather than hidden: `VACUUM INTO` is ONE synchronous
 * statement, where `db.backup()` yields to the event loop every 100 pages. On
 * a large database this blocks the server for the duration of the copy. That
 * is accepted for a deployment that has opted into encryption — the button is
 * pressed by an administrator, rarely — and it is why the unkeyed path below
 * is left exactly as it was rather than being unified: a deployment that never
 * set `LAWHA_DB_KEY` should not pay for a feature it did not enable.
 *
 * What this deliberately does NOT do is write to the archive. Forced snapshots
 * are for downloading, not for retention: the archive belongs to the
 * `lawha-backup` container, which is the only thing that may write there, and
 * this process only ever sees it read-only. A snapshot lives under the data
 * directory just long enough to be streamed, and is deleted.
 */

/** Where temp snapshots go, relative to the data directory. */
const SNAPSHOT_DIR_NAME = ".lawha-snapshots";

/**
 * Refuse if the copy would leave less than this much headroom beyond its own
 * size. A backup that fills the disk takes the live database down with it, and
 * the live database is on the same volume — so the failure mode of "back up
 * before something risky" would be causing the outage you were insuring
 * against.
 *
 * A fifth is a judgement, not a measurement. It is deliberately generous
 * because the cost of refusing wrongly is one annoyed admin, and the cost of
 * allowing wrongly is the whole deployment.
 */
const FREE_SPACE_MARGIN = 1.2;

export class SnapshotBusyError extends Error {}
export class SnapshotSpaceError extends Error {}
export class SnapshotVerificationError extends Error {}

export interface Snapshot {
  path: string;
  /** The name the download should carry, matching backup.mjs's convention. */
  filename: string;
  sizeBytes: number;
  counts: Record<string, number>;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * `lawha-YYYYMMDD-HHMMSS.db`, local time, same as `backup.mjs`. Local rather
 * than UTC so the name matches what an operator saw on the clock, and so a
 * lexicographic sort is still a chronological one.
 */
const stamp = (date = new Date()) =>
  `lawha-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}` +
  `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

export interface SnapshotTaker {
  /**
   * @throws SnapshotBusyError if one is already running
   * @throws SnapshotSpaceError if the volume cannot hold the copy
   * @throws SnapshotVerificationError if the copy fails integrity_check
   */
  create: () => Promise<Snapshot>;
  /** Delete a snapshot once it has been streamed, or abandoned. */
  release: (snapshotPath: string) => void;
}

export const createSnapshotTaker = (ctx: LawhaContext): SnapshotTaker => {
  const snapshotDir = path.join(
    path.dirname(ctx.config.dbPath),
    SNAPSHOT_DIR_NAME,
  );

  /**
   * Single-flight, because a snapshot is a full copy of the database. Two at
   * once is twice the disk and twice the page-walking against a live server,
   * and there is no reason to want it: the second admin's copy would be
   * seconds newer than the first's.
   *
   * A plain boolean rather than a queue — the right answer to "another one is
   * running" is to say so and let them click again, not to silently start a
   * second expensive job they will have forgotten about by the time it lands.
   */
  let inFlight = false;

  /**
   * Every file SQLite can leave beside a snapshot, not just the snapshot.
   *
   * `-journal` is the one that made this a list rather than a single name:
   * `VACUUM INTO` writes a rollback journal beside its target while it works
   * (measured, 1024 bytes), so a crash or a failed verification left
   * `<hex>.db-journal` in `.lawha-snapshots/` with nothing at the name it
   * belonged to and nothing anywhere that sweeps it — the ticket store's own
   * sweep only knows about snapshots it issued. `scripts/backup.mjs` has
   * carried the same list, for the same reason, since an interrupted run left
   * a dangling `-journal` in an operator's archive.
   */
  const SIDECARS = ["", "-wal", "-shm", "-journal"];

  /**
   * Synchronous on purpose. This runs in a request's `finally`, and the async
   * form let the response finish while the file was still on disk — which is
   * unobservable in production and made the test asserting the cleanup racy.
   * Four unlinks of four names is not worth an event-loop turn's ambiguity
   * either.
   */
  const release = (snapshotPath: string) => {
    for (const suffix of SIDECARS) {
      try {
        fs.rmSync(`${snapshotPath}${suffix}`, { force: true });
      } catch {
        // Already gone, or the directory went with it. Each gets its own
        // `try` because `{ force: true }` suppresses ENOENT and not ENOTDIR,
        // and one failing name must not stop the other three being removed.
      }
    }
  };

  return {
    release,

    create: async () => {
      if (inFlight) {
        throw new SnapshotBusyError(
          "A backup is already being prepared. Wait for it to finish.",
        );
      }

      inFlight = true;

      const destination = path.join(
        snapshotDir,
        // The ticket is what makes this unique, not the timestamp: two
        // snapshots inside the same second would otherwise collide on the
        // name, which is the TOCTOU race backup.mjs answers with "wait a
        // second and run it again". Here there is no reason to make anyone
        // wait — the download name is built separately.
        `${crypto.randomBytes(12).toString("hex")}.db`,
      );

      try {
        fs.mkdirSync(snapshotDir, { recursive: true });

        /**
         * How big the copy will be, asked of the database rather than of the
         * file on disk.
         *
         * `statSync(config.dbPath)` would be the obvious way and is wrong in
         * two directions. The live file is a WAL database, so its size on disk
         * understates the real content by however much is sitting in the
         * `-wal` — which is exactly the case where a naive check would pass
         * and then run out of space. And the tests run against `:memory:`,
         * where that path holds nothing at all. `page_count * page_size` is
         * the logical size of what is about to be written, in both.
         */
        const pageCount = (
          ctx.db.pragma("page_count") as Array<{ page_count: number }>
        )[0]?.page_count;
        const pageSize = (
          ctx.db.pragma("page_size") as Array<{ page_size: number }>
        )[0]?.page_size;
        const dbSize = (pageCount ?? 0) * (pageSize ?? 0);

        // statfs landed in Node 18.15; the runtime image is node:22-slim, so
        // this is safe. Guarded anyway because `yarn dev` runs on whatever the
        // developer has, and a missing precheck is not worth a crash.
        if (typeof fs.promises.statfs === "function") {
          const stats = await fs.promises.statfs(snapshotDir);
          const available = stats.bavail * stats.bsize;

          if (available < dbSize * FREE_SPACE_MARGIN) {
            throw new SnapshotSpaceError(
              `Not enough free space to take a backup: the database is ` +
                `${Math.round(dbSize / 1e6)} MB and only ` +
                `${Math.round(available / 1e6)} MB is free.`,
            );
          }
        }

        if (ctx.config.dbKey === null) {
          // The online backup API, on the live connection. Safe against the
          // server writing underneath it — it takes a read lock per page batch
          // rather than freezing anything.
          await ctx.db.backup(destination);

          // THE LINE THAT MAKES THE TAR SAFE. Opening the copy leaves a `-wal`
          // and a `-shm` beside it; forcing DELETE checkpoints them away, so
          // what ships is one self-contained file. The server sets WAL again
          // when it opens a restored database, so nothing is lost by storing
          // it this way.
          const copy = new Database(destination);
          copy.pragma("journal_mode = DELETE");
          copy.close();
        } else {
          // See the header comment. The bound parameter is deliberate — a key
          // is not involved here, but the destination path is built from a
          // random ticket and interpolating a path into SQL is a habit worth
          // not having. `VACUUM INTO` refuses an existing file, which is one
          // more reason the ticket makes the name unique.
          ctx.db.prepare("VACUUM INTO ?").run(destination);
          // No `journal_mode` pragma on this branch, and it is an absence with
          // a reason rather than an omission: `VACUUM INTO` writes a
          // rollback-journal database with no sidecars already (measured), and
          // re-opening the artefact only to set a mode it is already in would
          // be one more chance to leave a `-wal` beside the very file whose
          // whole point is not having one.
        }

        const verification = verifyBackupFile(destination, ctx.config.dbKey);

        if (!verification.ok) {
          // Unlike backup.mjs, a failed snapshot is deleted rather than kept
          // as `.rejected`. That file exists so an operator can inspect a bad
          // ARCHIVE entry; this one was never going to be retained, and
          // leaving corrupt copies in the data directory to be swept later is
          // how a disk fills.
          release(destination);
          throw new SnapshotVerificationError(
            `The backup failed verification and was discarded: ${verification.reason}`,
          );
        }

        return {
          path: destination,
          filename: `${stamp()}.db`,
          sizeBytes: fs.statSync(destination).size,
          counts: verification.counts ?? {},
        };
      } catch (error) {
        release(destination);
        throw error;
      } finally {
        inFlight = false;
      }
    },
  };
};
