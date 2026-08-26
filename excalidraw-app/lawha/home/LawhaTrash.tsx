import { useCallback, useEffect, useState } from "react";

import { listTrashedBoards, purgeBoard, restoreBoard } from "../../data/boards";

import { describeAge } from "./boardText";
import { plural } from "./homeText";

import type { TrashedBoard } from "../../data/boards";

/**
 * The trash: boards that were deleted and have not gone yet (ADR 0029).
 *
 * Its own component with its own fetch, rather than another branch inside
 * `HomeRoute`, which is already 1,280 lines. Nothing here shares state with
 * the grid — different endpoint, different row shape, none of the filters,
 * none of the selection, no drag — so folding it in would have added a
 * hundred lines to a file that is over the house ceiling and coupled two
 * lists that have no reason to know about each other.
 *
 * `onRestored` exists because the two lists are not independent in one
 * direction: a restored board belongs on the dashboard, and the dashboard's
 * copy of the board list was fetched before it came back.
 */

interface LawhaTrashProps {
  /** Reload the dashboard's board list — a restored board belongs on it. */
  onRestored: () => void;
  /**
   * Drop everything this browser holds about a board the server just destroyed.
   *
   * Owned by the route rather than done here, because it reaches four separate
   * local stores and the route is where the rest of that knowledge already
   * lives. Called only on the purge path: the board key is the last copy in
   * existence for legacy ciphertext boards and the undo history exists nowhere
   * else at all, so neither may be dropped on a delete that can still be
   * undone. See `forgetRebuildable` in `HomeRoute`.
   */
  onPurged: (boardId: string) => Promise<void>;
}

/** A "Delete for ever" waiting for its second click, by board id. */
type Pending = string | null;

/**
 * "in 12 days", or the reason there is no date.
 *
 * `null` is not "soon", it is "never" — this deployment has retention switched
 * off — and the two must not share a sentence. A board that will be kept
 * indefinitely being described as "deleted for ever in ..." would be the
 * screen lying about the only thing it is there to say.
 */
const describePurge = (purgeAt: number | null): string => {
  if (purgeAt === null) {
    return "kept until you delete it";
  }
  const remaining = purgeAt - Date.now();
  if (remaining <= 0) {
    // The sweep runs hourly, so an expired board can be listed for up to an
    // hour after its date. Saying "in -1 days" would read as a bug; saying it
    // is going says the true thing without pretending to know when.
    return "deleting soon";
  }
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  return `deleting in ${plural(days, "day")}`;
};

export const LawhaTrash = ({ onRestored, onPurged }: LawhaTrashProps) => {
  const [boards, setBoards] = useState<TrashedBoard[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listTrashedBoards();
      setBoards(list.boards);
      setRetentionDays(list.retentionDays);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load the trash.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRestore = async (board: TrashedBoard) => {
    setBusyId(board.id);
    try {
      await restoreBoard(board.id);
      // Both, and in this order. Dropping the row locally is what makes the
      // click feel like it did something; reloading the dashboard is what puts
      // the board back where the user expects to find it next.
      setBoards((current) => current.filter((row) => row.id !== board.id));
      onRestored();
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not restore it.",
      );
      // The optimistic removal above did not run on this path, but the server's
      // idea of the trash may have moved on regardless — another tab, or the
      // sweep. Re-read rather than guess.
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const onPurge = async (board: TrashedBoard) => {
    setBusyId(board.id);
    try {
      await purgeBoard(board.id);
      // After the server confirmed, never before. Clearing on an optimistic
      // assumption would destroy the local key and undo history of a board the
      // request failed to delete — the one case where the local copies are
      // still the only ones that matter.
      await onPurged(board.id);
      setBoards((current) => current.filter((row) => row.id !== board.id));
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not delete it.",
      );
      await reload();
    } finally {
      setBusyId(null);
      setPending(null);
    }
  };

  return (
    <div className="lw-trash">
      <div className="lw-trash__head">
        <h1 className="lw-home__heading">Trash</h1>
        <p className="lw-trash__note">
          {/*
            Stated on an empty trash too, which is the only time it is any use.
            A retention rule explained at the moment there is already something
            in the bin has been explained too late to change what anyone did.
          */}
          {retentionDays === null
            ? null
            : retentionDays === 0
            ? "Deleted boards are kept until you delete them for good."
            : `Deleted boards are kept for ${plural(
                retentionDays,
                "day",
              )}, then removed for good.`}
        </p>
      </div>

      {error ? (
        <div className="lw-home__error" role="alert">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <p className="lw-trash__empty">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="lw-trash__empty">The trash is empty.</p>
      ) : (
        <ul className="lw-trash__list">
          {boards.map((board) => {
            const isBusy = busyId === board.id;
            const isPending = pending === board.id;

            return (
              <li key={board.id} className="lw-trash__row">
                <div className="lw-trash__about">
                  <span className="lw-trash__name">{board.name}</span>
                  <span className="lw-trash__meta">
                    deleted {describeAge(board.deletedAt)} ·{" "}
                    {describePurge(board.purgeAt)}
                  </span>
                </div>

                {isPending ? (
                  /*
                   * The confirm step, in place. No `window.confirm` on any path
                   * the app can reach on its own (invariant 19) — a native
                   * dialog blocks the renderer's main thread, and this one
                   * would fire on a screen where a board may be seconds from
                   * being unrecoverable.
                   */
                  <div className="lw-trash__confirm">
                    <span className="lw-trash__confirm-text">
                      Delete for good? This cannot be undone.
                    </span>
                    <button
                      type="button"
                      className="lw-trash__action lw-trash__action--danger"
                      disabled={isBusy}
                      onClick={() => void onPurge(board)}
                    >
                      Delete for ever
                    </button>
                    <button
                      type="button"
                      className="lw-trash__action"
                      disabled={isBusy}
                      onClick={() => setPending(null)}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <div className="lw-trash__actions">
                    <button
                      type="button"
                      className="lw-trash__action lw-trash__action--primary"
                      disabled={isBusy}
                      onClick={() => void onRestore(board)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="lw-trash__action"
                      disabled={isBusy}
                      onClick={() => setPending(board.id)}
                    >
                      Delete for ever
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
