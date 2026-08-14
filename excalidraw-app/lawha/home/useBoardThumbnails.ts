import { useEffect, useMemo, useState } from "react";

import { buildBoardThumbnail } from "./boardThumbnail";

import type { BoardThumbnail } from "./boardThumbnail";
import type { BoardListEntry } from "../../data/boards";

/**
 * What each board looks like, and how much is on it, for a whole grid at once.
 *
 * Owned by the route rather than by the card, because the shape count is not
 * only a label — it is the key "Most shapes" sorts by, and a sort cannot ask
 * each card what it happens to have decrypted. Hoisting it also means switching
 * between Tiles and Details re-uses one decrypt instead of starting a second.
 *
 * Three states, kept apart on purpose:
 *
 *   absent from the map — not decrypted yet
 *   present and null    — decrypted as far as it can be, and unreadable here
 *                         (no key on this device, or no scene stored yet)
 *   present with a value — readable
 *
 * Collapsing the first two would make every board claim to be locked for the
 * first few hundred milliseconds of every page load, and collapsing the last
 * two would make an unreadable board claim to be empty.
 */
export type BoardThumbnails = ReadonlyMap<string, BoardThumbnail | null>;

const EMPTY: BoardThumbnails = new Map();

export const useBoardThumbnails = (
  boards: readonly BoardListEntry[],
): BoardThumbnails => {
  const [thumbnails, setThumbnails] = useState<BoardThumbnails>(EMPTY);

  // The board array is rebuilt by `matchBoards` on every keystroke, so its
  // identity says nothing. What matters is which boards, at which revision —
  // `updatedAt` is bumped by the server on every scene write, so a board that
  // has been drawn on since the last pass appears here as a different target
  // and is decrypted again.
  const signature = boards
    .map((board) => `${board.id}:${board.updatedAt}`)
    .join(",");

  const targets = useMemo(
    () => boards.map((board) => ({ id: board.id, updatedAt: board.updatedAt })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  useEffect(() => {
    let cancelled = false;

    // `forEach` rather than `for…of`: the callback closes over `cancelled`,
    // which the cleanup below flips, and a function declared inside a `for`
    // body capturing a mutable outer binding is exactly what `no-loop-func`
    // exists to flag. It is safe here — `cancelled` is read at resolve time,
    // which is the intent — but writing it in the shape the rule cannot
    // misread is cheaper than an eslint-disable that outlives the reason.
    targets.forEach((target) => {
      void buildBoardThumbnail(target.id, target.updatedAt).then((built) => {
        if (cancelled) {
          return;
        }
        setThumbnails((current) => {
          if (current.get(target.id) === built) {
            // Same object identity means the cache handed back the same
            // resolved promise, so nothing has changed and a new Map here would
            // re-render the whole grid for nothing.
            return current;
          }
          const next = new Map(current);
          next.set(target.id, built);
          return next;
        });
      });
    });

    return () => {
      cancelled = true;
    };
  }, [targets]);

  return thumbnails;
};

/**
 * Just the counts, for the sort.
 *
 * Boards that are still decrypting and boards that cannot be read are both
 * left out, which is what puts them at the end of a "Most shapes" ordering —
 * `sortBoards` treats an absent count as unknown rather than as zero.
 */
export const shapeCountsOf = (
  thumbnails: BoardThumbnails,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const [boardId, thumbnail] of thumbnails) {
    if (thumbnail) {
      counts.set(boardId, thumbnail.count);
    }
  }
  return counts;
};
