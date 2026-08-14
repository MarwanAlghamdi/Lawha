import path from "node:path";

import { Router } from "express";

import {
  listArchiveEntries,
  readBackupStatus,
  resolveArchiveBlobsDir,
  resolveArchiveEntryPath,
} from "../../lib/backupArchive.js";
import { streamBackupTar } from "../../lib/backupTar.js";
import { createBackupTicketStore } from "../../lib/backupTickets.js";
import {
  SnapshotBusyError,
  SnapshotSpaceError,
  SnapshotVerificationError,
  createSnapshotTaker,
} from "../../lib/backupSnapshot.js";
import { verifyPassword } from "../../lib/password.js";
import { adminBackupStepUpSchema } from "../../lib/validation.js";
import {
  asyncHandler,
  conflict,
  insufficientStorage,
  notFound,
  unauthorized,
} from "../middleware/errors.js";
import { RateLimiter, callerOf, rateLimit } from "../middleware/rateLimit.js";

import type { LawhaContext } from "../../context.js";
import type { Request, Response, Router as ExpressRouter } from "express";

/**
 * Taking a backup, and getting one out of the building.
 *
 * Mounted under the admin router, so `requireAdmin` and the admin read limiter
 * already apply to everything here — this file adds only what is specific to
 * backups. That inheritance is load-bearing: forgetting a guard on a route
 * that hands over the entire database would be the worst possible place to
 * forget one, so it is not left to per-route discipline.
 *
 * The shape of a download is three steps rather than one, and the reason is
 * mechanical. The step-up password must travel in a POST body, because a
 * password in a URL lands in browser history, in the nginx access log and in
 * anything watching the wire before TLS. But a POST cannot produce a native
 * save-to-disk download, and reading the response with `fetch` to make a blob
 * would hold the whole archive in the tab's memory. So: POST proves who is
 * asking and returns a ticket, a plain GET redeems it once and streams to
 * disk, and the ticket is dead sixty seconds later.
 */

const ONE_HOUR = 60 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Snapshots, per caller, per hour.
 *
 * Three, because a snapshot is a full copy of the database. This is not a
 * credential-stuffing limit, it is a resource limit — the expensive thing here
 * is the disk, not the argon2 verify.
 *
 * Known cost, accepted rather than overlooked: a mistyped password burns one
 * of the three, because the same route verifies and then backs up. Splitting
 * them would need a second round trip and a second ticket type to buy an admin
 * two extra typos an hour. If operators actually hit this, split it then.
 */
const SNAPSHOT_LIMIT = 3;

/**
 * Archive downloads, per caller, per quarter hour.
 *
 * Looser than snapshots because redeeming one costs a read of a file that
 * already exists, and tighter than the admin read limit because each one is
 * still the whole database going out of the door.
 */
const ARCHIVE_TICKET_LIMIT = 20;

/**
 * Does this caller still know their password?
 *
 * The split follows the one the rest of the server already uses. A master-only
 * administration session has no account behind it (migration 007), so the only
 * thing it can be asked to re-prove is the master password. Anyone with a
 * `req.user` — including someone whose session was opened WITH the master
 * password — re-proves that account's own password, because that is the
 * credential they are holding.
 *
 * Both paths cost a real argon2 verify. The failure answer is identical and
 * says nothing about which credential was checked or whether the account
 * exists.
 */
const verifyStepUp = async (
  ctx: LawhaContext,
  req: Request,
  password: string,
): Promise<boolean> => {
  if (req.user) {
    const row = ctx.users.findById(req.user.id);
    return row ? verifyPassword(row.password_hash, password) : false;
  }

  if (req.masterAdmin === true) {
    return ctx.masterPassword.verify(password);
  }

  return false;
};

/**
 * Which session a ticket belongs to.
 *
 * For an account, the account. For a master-password session, the SPECIFIC
 * admin session token rather than the address — `callerOf` buckets master
 * sessions by IP for rate limiting, which is right for a quota and wrong for a
 * capability. Two administrators behind the same NAT must not be able to
 * collect each other's downloads.
 */
const ownerKeyOf = (req: Request): string | null => {
  if (req.user) {
    return `u:${req.user.id}`;
  }
  if (req.masterAdmin === true && req.adminSessionToken) {
    return `admin:${req.adminSessionToken}`;
  }
  return null;
};

const auditActor = (req: Request) => ({
  actorUserId: req.user?.id ?? null,
  actorLabel: req.user?.username ?? "the master password",
  viaMaster: req.viaMaster === true || req.masterAdmin === true,
});

export const createAdminBackupRouter = (ctx: LawhaContext): ExpressRouter => {
  const router = Router();

  const snapshots = new RateLimiter({
    limit: SNAPSHOT_LIMIT,
    windowMs: ONE_HOUR,
  });
  const archiveTickets = new RateLimiter({
    limit: ARCHIVE_TICKET_LIMIT,
    windowMs: FIFTEEN_MINUTES,
  });

  const tickets = createBackupTicketStore();
  const snapshotTaker = createSnapshotTaker(ctx);

  /** Where staging symlinks may be written — never the read-only archive. */
  const workDir = path.dirname(ctx.config.dbPath);

  /**
   * What the scheduler says about itself.
   *
   * Read from the `lawha-backup` container's own status file rather than
   * recomputed here, so `docker compose ps` and this panel cannot disagree
   * about whether backups are healthy. One writer, two readers.
   */
  router.get(
    "/status",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(readBackupStatus(ctx));
    }),
  );

  router.get(
    "/archive",
    asyncHandler(async (_req: Request, res: Response) => {
      if (!ctx.config.backupArchiveDir) {
        throw notFound(
          "This server has no backup archive mounted.",
          "ARCHIVE_NOT_CONFIGURED",
        );
      }

      res.json({ entries: listArchiveEntries(ctx) });
    }),
  );

  /**
   * Take a backup now, and hand back a ticket to collect it with.
   *
   * The snapshot is taken BEFORE the ticket is issued, so the response either
   * carries a ticket for a file that exists and has passed verification, or an
   * error. A ticket that might turn out to be worthless would push the failure
   * into the download, where the browser has already committed to a navigation
   * and the only place left to report it is a page the user cannot see.
   */
  router.post(
    "/snapshot",
    rateLimit(snapshots, callerOf),
    asyncHandler(async (req: Request, res: Response) => {
      const body = adminBackupStepUpSchema.parse(req.body);
      const ownerKey = ownerKeyOf(req);

      if (!ownerKey || !(await verifyStepUp(ctx, req, body.password))) {
        throw unauthorized("That password is not correct.");
      }

      try {
        const snapshot = await snapshotTaker.create();

        const issued = tickets.issue({
          kind: "snapshot",
          ownerKey,
          snapshotPath: snapshot.path,
        });

        res.status(201).json({
          ...issued,
          filename: `${snapshot.filename}.tar`,
          sizeBytes: snapshot.sizeBytes,
          counts: snapshot.counts,
        });
      } catch (error) {
        if (error instanceof SnapshotBusyError) {
          throw conflict(error.message, "SNAPSHOT_IN_PROGRESS");
        }
        if (error instanceof SnapshotSpaceError) {
          throw insufficientStorage(error.message);
        }
        if (error instanceof SnapshotVerificationError) {
          // Deliberately surfaced rather than swallowed into a generic 500.
          // A backup that failed its own integrity check is the one thing an
          // operator must not be allowed to believe succeeded.
          throw conflict(error.message, "SNAPSHOT_VERIFICATION_FAILED");
        }
        throw error;
      }
    }),
  );

  router.post(
    "/archive/:entryId/ticket",
    rateLimit(archiveTickets, callerOf),
    asyncHandler(async (req: Request, res: Response) => {
      const body = adminBackupStepUpSchema.parse(req.body);
      const ownerKey = ownerKeyOf(req);
      const entryId = req.params.entryId ?? "";

      // Path validation BEFORE the password check, and before touching the
      // disk: a traversal attempt should not get to spend argon2 time, and the
      // answer must not depend on whether the password was right.
      const entryPath = resolveArchiveEntryPath(ctx, entryId);

      if (!entryPath) {
        throw notFound("No such backup.", "ARCHIVE_ENTRY_NOT_FOUND");
      }

      if (!ownerKey || !(await verifyStepUp(ctx, req, body.password))) {
        throw unauthorized("That password is not correct.");
      }

      res.status(201).json(
        tickets.issue({
          kind: "archive",
          ownerKey,
          archiveEntryId: entryId,
        }),
      );
    }),
  );

  /**
   * Redeem a ticket and stream the archive.
   *
   * A GET with no body, because this is the request the BROWSER makes — a
   * top-level navigation that turns into a save-to-disk download. It carries
   * no password; the ticket in the path is the entire authority, which is why
   * it is single-use, expires in a minute, and is bound to the session that
   * asked for it.
   */
  router.get(
    "/download/:ticketId",
    asyncHandler(async (req: Request, res: Response) => {
      const ownerKey = ownerKeyOf(req);
      const ticket =
        ownerKey && req.params.ticketId
          ? tickets.redeem(req.params.ticketId, ownerKey)
          : undefined;

      if (!ticket) {
        // One answer for unknown, expired, spent and wrong-owner. Telling them
        // apart would tell someone holding a stale URL which of those it was.
        throw notFound(
          "That download link has expired. Ask for the backup again.",
          "TICKET_INVALID",
        );
      }

      const isSnapshot = ticket.kind === "snapshot";

      const dbPath = isSnapshot
        ? ticket.snapshotPath!
        : resolveArchiveEntryPath(ctx, ticket.archiveEntryId!);

      if (!dbPath) {
        throw notFound("No such backup.", "ARCHIVE_ENTRY_NOT_FOUND");
      }

      /**
       * A fresh snapshot ships the LIVE blobs, because it was taken from the
       * live database a moment ago and they belong together.
       *
       * An archived database ships the backup container's append-only mirror
       * instead, and the difference matters: the mirror still holds blobs that
       * an old database references and that the live deployment has since
       * deleted. Pairing a three-month-old database with today's blobs would
       * restore boards whose images had quietly gone.
       */
      const blobs = isSnapshot
        ? { dir: ctx.config.filesDir, mirrored: false }
        : resolveArchiveBlobsDir(ctx);

      // An archive entry now comes in two shapes — `lawha-<stamp>.db` and
      // `lawha-<stamp>.db.age` (see backupArchive.ts) — and `path.basename`'s
      // suffix argument only strips an EXACT trailing match, so stripping
      // `.db` unconditionally left an encrypted entry downloading as
      // `lawha-<stamp>.db.age.tar` instead of `lawha-<stamp>.tar`. Cosmetic,
      // not a correctness bug — the tar's own inner entry name (`dbEntryName`
      // below) is what a restore actually reads — but there is no reason to
      // ship the doubled extension now that this path is reachable at all.
      const archiveSuffix = ticket.archiveEntryId?.endsWith(".db.age")
        ? ".db.age"
        : ".db";
      const filename = isSnapshot
        ? `${path.basename(ticket.snapshotPath!, ".db")}.tar`
        : `${path.basename(ticket.archiveEntryId!, archiveSuffix)}.tar`;

      ctx.audit.record({
        ...auditActor(req),
        action: "backup.downloaded",
        targetLabel: isSnapshot
          ? "a backup taken just now"
          : ticket.archiveEntryId!,
        detail:
          blobs.mirrored || isSnapshot
            ? null
            : // Recorded because it changes what the file is worth on restore
              // day, and the person downloading it cannot tell from the bytes.
              "uploaded files came from the live directory, not the backup mirror",
      });

      res.status(200).set({
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // No Content-Length: the size is not known without walking the blobs,
        // which is the same walk tar is about to do. An indeterminate progress
        // bar is a smaller cost than doing the work twice.
        //
        // `no-store` because this response is the entire database. Nothing
        // between here and the disk should keep a copy.
        "Cache-Control": "no-store",
      });

      try {
        await streamBackupTar(res, {
          dbPath,
          // Named for the backup, not for the temp file it lived in. A
          // downloaded archive containing `a3f9c2....db` tells the person
          // restoring it nothing.
          dbEntryName: isSnapshot ? "lawha.db" : ticket.archiveEntryId!,
          blobsDir: blobs.dir,
          workDir,
        });
      } finally {
        // Whatever happened — completed, client hung up mid-transfer, tar
        // threw — the temp copy goes. It is a full database sitting on the
        // same volume as the live one, and the sweep in the ticket store only
        // catches the ones that were never redeemed.
        if (isSnapshot) {
          snapshotTaker.release(ticket.snapshotPath!);
        }
      }
    }),
  );

  return router;
};
