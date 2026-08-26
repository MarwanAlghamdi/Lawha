import fs from "node:fs/promises";
import path from "node:path";

import { isValidRoomId } from "../protocol.js";
import { resolveAvatarDir } from "../http/routes/users.js";
import {
  notifyBoardAccessChanged,
  notifyUserSessionsRevoked,
} from "../socket/liveAccess.js";

import type { LawhaContext } from "../context.js";

/**
 * Destroying an account for good — the half of ADR 0031 that removes things.
 *
 * A sibling of `trashSweep.ts` rather than a section inside it. The shape is
 * the same on purpose (`purgeX`, `sweepExpiredX`, `startXSweep`) because the
 * two features are the same idea applied to two entities, but the entities are
 * genuinely different: a different repository, a different retention subject,
 * and different side effects on disk — a board owns a room directory, an
 * account owns an avatar *and* every one of its boards' room directories.
 *
 * Two callers, and they must not diverge: the retention sweep below, and
 * `DELETE /api/auth/me`, which deletes immediately rather than waiting (ADR
 * 0031 explains the asymmetry — a person deleting their own account with their
 * own password is making an informed choice, and holding their username for a
 * month would be the worse outcome).
 */

/** Hourly, matching the session and board sweeps. */
export const ACCOUNT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Removes the directories an account owns: its avatar, and one per board.
 *
 * Best-effort and never throws. By the time this runs the rows are already
 * gone, so reporting failure to a caller who cannot undo the delete would turn
 * a leaked directory into a 500. It does not stay quiet either — an operator
 * cleaning up by hand needs the user id, what was being removed, and the exact
 * path. The avatar matters most: until that `rm` succeeds it is still a
 * recognisable picture of a deleted person.
 */
const removeAccountFiles = async (
  ctx: LawhaContext,
  userId: string,
  boardIds: readonly string[],
): Promise<void> => {
  const logFailure = (what: string, target: string, error: unknown) => {
    process.stderr.write(
      `lawha: failed to remove ${what} for deleted user ${userId} ` +
        `(${target}): ${describe(error)}\n`,
    );
  };

  const avatarDir = resolveAvatarDir(ctx.config.filesDir, userId);

  await Promise.all([
    // Re-validated before becoming a path component. Board ids arrive from
    // clients, and a `..` reaching `path.resolve` would delete the wrong tree
    // entirely — having been accepted as an id elsewhere is not a licence to
    // trust it as a filename.
    ...boardIds.filter(isValidRoomId).map((boardId) => {
      const roomDir = path.resolve(ctx.config.filesDir, "rooms", boardId);
      return fs
        .rm(roomDir, { recursive: true, force: true })
        .catch((error: unknown) =>
          logFailure(`board ${boardId}`, roomDir, error),
        );
    }),
    ...(avatarDir
      ? [
          fs
            .rm(avatarDir, { recursive: true, force: true })
            .catch((error: unknown) => logFailure("avatar", avatarDir, error)),
        ]
      : []),
  ]);
};

/**
 * Deletes an account for good — rows, cascade, sockets and disk.
 *
 * **Delegates the transaction to `UsersRepository.deleteAccount` and does not
 * reimplement it.** That method knows three things this one must not have to
 * remember: which columns reference `users` without a cascade and would abort
 * the DELETE, that `files` rows are not reachable from `boards` by any foreign
 * key and have to be removed per board by hand, and that every purged board id
 * needs a tombstone or the id becomes claimable again (ADR 0029). A rewrite
 * here that "just" issued the DELETE would reopen all three, silently.
 *
 * `requireDeleted` is how a caller says "only if it is still in the trash",
 * and the sweep is the caller that means it. Without it the sweep's own
 * listing is the only check, and that listing is stale the moment it is taken:
 * every `await` below yields — the socket eviction, the fan-out, a recursive
 * `fs.rm` — and an administrator pressing Restore during any of them gets a
 * 200 and a panel saying the account is back, moments before the loop reaches
 * it and destroys the account and every board it owns. `BoardsRepository.purge`
 * guards on `deleted_at IS NOT NULL` for exactly this reason.
 *
 * It is not the default, because `DELETE /api/auth/me` purges a **live**
 * account: there is no soft phase on the path where somebody deletes their own
 * account with their own password.
 *
 * Returns false when nothing was purged, so a sweep can tell a row that was
 * restored out from under it from one it actually destroyed.
 */
export const purgeAccount = async (
  ctx: LawhaContext,
  userId: string,
  { requireDeleted = false }: { requireDeleted?: boolean } = {},
): Promise<boolean> => {
  const row = ctx.users.findById(userId);
  if (!row || (requireDeleted && row.deleted_at === null)) {
    return false;
  }

  const { deletedBoardIds } = ctx.users.deleteAccount(userId);

  // Every live socket this account holds, anywhere. No `keepSessionToken`:
  // unlike a password change there is no session left to spare.
  await notifyUserSessionsRevoked(userId);

  // The account's OWN boards are gone as rows now, not merely unreachable —
  // `deleteAccount` cascades them away. Anyone else still sitting in one of
  // those rooms (a co-member, a share-link guest) has to be re-checked and
  // evicted the same way `DELETE /boards/:boardId` does for a single board, or
  // they keep relaying edits into a room whose board no longer exists.
  //
  // Kept on the purge path even though the admin route already evicted these
  // rooms thirty days earlier: this is also the immediate path for a person
  // deleting their own account, where nothing has evicted anyone yet. Running
  // it twice costs one re-resolve of an empty room.
  await Promise.all(
    deletedBoardIds.map((boardId) => notifyBoardAccessChanged(boardId)),
  );

  await removeAccountFiles(ctx, userId, deletedBoardIds);

  return true;
};

/**
 * Purges every account whose retention window has closed. Returns how many.
 *
 * Shares `LAWHA_TRASH_RETENTION_DAYS` with the board trash rather than adding
 * a second setting: "a deleted thing is kept for N days" is one rule, and two
 * knobs that almost always hold the same number is two chances to set one of
 * them wrong.
 *
 * Returns 0 without querying when retention is off, for the same reason the
 * board sweep does: `deletedAt < now - 0` is not the query that expresses
 * "never", it is one that happens to match nothing today.
 */
export const sweepExpiredAccounts = async (
  ctx: LawhaContext,
  now = Date.now(),
): Promise<number> => {
  const retentionMs = ctx.config.trashRetentionMs;
  if (retentionMs <= 0) {
    return 0;
  }

  const expired = ctx.users.findExpiredDeleted(now - retentionMs);
  let purged = 0;

  for (const userId of expired) {
    // Sequential, not `Promise.all`. Nobody is waiting on this, and a hundred
    // concurrent recursive `rm`s is a worse neighbour to live board traffic
    // than a sweep that takes a few seconds longer.
    // Re-checked against the row, not against the listing that produced it.
    if (await purgeAccount(ctx, userId, { requireDeleted: true })) {
      purged += 1;
    }
  }

  return purged;
};

/**
 * Starts the hourly account sweep and returns its timer.
 *
 * Runs once immediately, then hourly, and every pass is wrapped — housekeeping
 * must never be the thing that takes the server down. An unguarded rejection
 * out of a timer callback is a process exit, and every open board drops.
 */
export const startAccountSweep = (ctx: LawhaContext): NodeJS.Timeout => {
  const pass = () => {
    void sweepExpiredAccounts(ctx)
      .then((purged) => {
        if (purged > 0) {
          process.stdout.write(
            `lawha: purged ${purged} account${purged === 1 ? "" : "s"} ` +
              `whose ${ctx.config.trashRetentionDays}-day retention had expired\n`,
          );
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `lawha: account sweep failed, will retry in an hour: ${describe(
            error,
          )}\n`,
        );
      });
  };

  pass();
  const timer = setInterval(pass, ACCOUNT_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
};
