import fs from "node:fs/promises";
import path from "node:path";

import { isValidRoomId } from "../protocol.js";

import type { LawhaContext } from "../context.js";

/**
 * Hard deletion: the half of the trash that actually removes things (ADR 0029).
 *
 * One module rather than two code paths, because there are two callers that
 * must not diverge — the hourly retention sweep and the "Delete for ever"
 * button — and the thing they share is not a SQL statement. It is the fact
 * that a board is a database row *and* a directory of uploaded images, that
 * only the row is reachable by a foreign key, and that forgetting the second
 * half leaks disk silently for ever. A route that wrote its own `DELETE` would
 * look complete and be wrong; this is the file that makes that hard to do.
 */

/** Hourly, matching the session sweep. */
export const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Removes a board's uploaded images from disk.
 *
 * Best-effort and never throws: the row is already gone by the time this runs,
 * and reporting failure to a caller who cannot undo the delete would only turn
 * a leaked directory into a 500. It does not stay quiet either — an operator
 * cleaning this up by hand needs the board id and the exact path, which is why
 * the message carries both. Same shape as the account-deletion cleanup in
 * `routes/auth.ts`, and for the same reasons.
 */
const removeBoardFiles = async (
  ctx: LawhaContext,
  boardId: string,
): Promise<void> => {
  // Re-validated before it becomes a path component. Board ids arrive from
  // clients, and a `..` reaching `path.resolve` here would delete the wrong
  // tree entirely. Having been accepted as an id elsewhere is not a licence to
  // trust it as a filename.
  if (!isValidRoomId(boardId)) {
    process.stderr.write(
      `lawha: refusing to remove files for board id that is not a valid room id (${boardId})\n`,
    );
    return;
  }

  const roomDir = path.resolve(ctx.config.filesDir, "rooms", boardId);
  try {
    await fs.rm(roomDir, { recursive: true, force: true });
  } catch (error: unknown) {
    process.stderr.write(
      `lawha: failed to remove files for purged board ${boardId} ` +
        `(${roomDir}): ${describe(error)}\n`,
    );
  }
};

/**
 * Deletes one board for good — row, cascade, `files` rows, and the directory.
 *
 * The row goes first and the disk second, deliberately. The reverse order has
 * a window in which the images are gone and the board is still listed, which
 * is a board that opens with broken pictures; this order's window has the row
 * gone and a directory briefly orphaned, which is invisible and is cleaned up
 * by the next operator sweep. Neither is free, and the one nobody sees is the
 * one to choose.
 *
 * `purge` returns false when the id did not name a *trashed* board, in which
 * case nothing is touched on disk either — a board that was restored between
 * the sweep listing it and the sweep reaching it keeps its images.
 */
export const purgeBoard = async (
  ctx: LawhaContext,
  boardId: string,
): Promise<boolean> => {
  if (!ctx.boards.purge(boardId)) {
    return false;
  }
  await removeBoardFiles(ctx, boardId);
  return true;
};

/**
 * Purges every board whose retention window has closed. Returns how many went.
 *
 * Returns 0 without touching the database when retention is switched off. The
 * check is here rather than in the SQL because `deletedAt < 0` is not the query
 * that expresses "never" — it is a query that happens to match nothing today
 * and would match the whole trash if the arithmetic ever changed sign.
 */
export const sweepExpiredTrash = async (
  ctx: LawhaContext,
  now = Date.now(),
): Promise<number> => {
  const retentionMs = ctx.config.trashRetentionMs;
  if (retentionMs <= 0) {
    return 0;
  }

  const expired = ctx.boards.findExpiredTrash(now - retentionMs);
  let purged = 0;

  for (const boardId of expired) {
    // Sequential, not `Promise.all`. This runs on a schedule with nobody
    // waiting on it, and a hundred concurrent recursive `rm`s on a Raspberry
    // Pi is a worse neighbour to the live board traffic than a sweep that
    // takes a few seconds longer.
    if (await purgeBoard(ctx, boardId)) {
      purged += 1;
    }
  }

  return purged;
};

/**
 * Starts the hourly sweep and returns its timer.
 *
 * Runs once immediately, then hourly. The immediate pass is what makes a
 * server that was switched off for six weeks catch up on boot rather than at
 * the top of the hour, and — more to the point — is what makes the feature
 * testable without waiting an hour.
 *
 * Every pass is wrapped: housekeeping must never be the thing that takes the
 * server down. An unguarded rejection out of a timer callback is a process
 * exit, and every open board drops, for a sweep whose only job is to delete
 * rows nobody is coming back for. Skipping one hour costs nothing.
 */
export const startTrashSweep = (ctx: LawhaContext): NodeJS.Timeout => {
  const pass = () => {
    void sweepExpiredTrash(ctx)
      .then((purged) => {
        if (purged > 0) {
          process.stdout.write(
            `lawha: purged ${purged} board${purged === 1 ? "" : "s"} ` +
              `whose ${ctx.config.trashRetentionDays}-day retention had expired\n`,
          );
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `lawha: trash sweep failed, will retry in an hour: ${describe(
            error,
          )}\n`,
        );
      });
  };

  pass();
  const timer = setInterval(pass, TRASH_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
};
