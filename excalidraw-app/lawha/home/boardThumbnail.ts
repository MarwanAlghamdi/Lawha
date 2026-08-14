import type { ExcalidrawElement } from "@excalidraw/element/types";

import { resolveBoardKey } from "../../data/boardKeys";
import { loadFromBackend } from "../../data/storage";

/** One element, reduced to what a 292×162 preview can actually show. */
export interface ThumbnailShape {
  /** Percentages of the preview box, so the CSS needs no pixel maths. */
  left: number;
  top: number;
  width: number;
  height: number;
  stroke: string;
  fill: string;
  rounded: boolean;
  /** Lines and arrows draw as a hairline rather than a box. */
  hairline: boolean;
}

export interface BoardThumbnail {
  /** At most `MAX_SHAPES`, laid out for the preview plate. */
  shapes: ThumbnailShape[];
  /**
   * **Every** drawable element, not just the ones drawn.
   *
   * This is the "68 shapes" on the card and the key the "Most shapes" sort
   * orders by, so it must not inherit the preview's cap — a 400-element board
   * and a 60-element board would tie at 60 and the sort would look broken.
   */
  count: number;
}

/**
 * Enough to read a board at a glance, few enough to stay cheap. Boards run to
 * thousands of elements; drawing all of them into a 292px box would be a lot of
 * DOM for something the size of a postage stamp.
 */
const MAX_SHAPES = 60;

/** Leaves the drawing a little air inside the plate, as the mockup does. */
const PADDING = 0.07;

const isDrawable = (element: ExcalidrawElement) =>
  !element.isDeleted && element.width > 0 && element.height > 0;

/**
 * One decrypt per board per revision, shared by everything that asks.
 *
 * Three surfaces now want the same scene: the card's preview, the Details row's
 * shape count, and the sort that orders by it. Decrypting once per surface
 * would triple the work on every view switch, and — worse — let the number on a
 * card disagree with the number the sort used, which reads as the sort being
 * broken rather than as two decrypts of one board.
 *
 * Keyed on `updatedAt` as well as the id, and that is what makes the cache safe
 * to keep across navigations: the server bumps `boards.updated_at` on every
 * scene write (`ScenesRepository.touchBoard`), so drawing on a board and coming
 * back to the dashboard produces a different key and a fresh decrypt. Without
 * the revision in the key this would be a cache that shows you the board as it
 * was when you opened the tab.
 *
 * Promises are cached, not values, so two components mounting in the same tick
 * share one decrypt rather than racing.
 */
const cache = new Map<string, Promise<BoardThumbnail | null>>();

/** Bounded so a long session on a large dashboard cannot grow without limit. */
const MAX_CACHED = 240;

/**
 * A miniature of a board, built from the board's real scene.
 *
 * The server cannot produce this: it holds ciphertext and no key. So the
 * dashboard decrypts the scene itself, with the key already in this device's
 * store, and lays the element bounds out as coloured boxes — the same thing the
 * mockup draws by hand. It is a sketch of the board, not a render of it: no
 * text, no freedraw paths, no images.
 *
 * Returns null when there is nothing to show, which covers every failure too —
 * a missing key, a board with no scene yet, a decrypt that fails because the
 * key is wrong. A card with an empty plate is a fine outcome; a card that
 * throws is not. Null is therefore *not* the same as `{ count: 0 }`, and the
 * dashboard keeps them apart: an unreadable board says so and sorts last,
 * rather than claiming to be empty.
 */
export const buildBoardThumbnail = (
  boardId: string,
  updatedAt: number,
): Promise<BoardThumbnail | null> => {
  const key = `${boardId}:${updatedAt}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const pending = decrypt(boardId);
  cache.set(key, pending);

  if (cache.size > MAX_CACHED) {
    // Insertion order, so the oldest key goes. A Map iterator's first entry is
    // the least recently *added*, which is close enough to least recently used
    // for a dashboard that renders a screenful at a time.
    cache.delete(cache.keys().next().value!);
  }

  return pending;
};

/** Drops every cached revision of a board. Called when one is deleted. */
export const forgetBoardThumbnail = (boardId: string): void => {
  for (const key of cache.keys()) {
    if (key.startsWith(`${boardId}:`)) {
      cache.delete(key);
    }
  }
};

const decrypt = async (boardId: string): Promise<BoardThumbnail | null> => {
  try {
    // Resolved, and NOT required. `if (!key) return null` stood here, and it
    // is the shape the locked card had: a board with no key drew an empty
    // plate. Every board created since ADR 0012 has no key at all, so that
    // guard turned "the scene is plaintext" into "every new board previews as
    // empty" — caught in a screenshot of the dashboard, where a board holding
    // a rectangle reported "empty" beside it.
    //
    // Still resolved rather than skipped, because a board stored before ADR
    // 0012 does need one to be read. Null is passed straight through;
    // `loadFromBackend` needs a key only if the row it fetches is encrypted.
    // No link is passed either — there is no fragment to read on the dashboard.
    const key = await resolveBoardKey(boardId, null);

    const elements = await loadFromBackend(boardId, key, null);
    const drawable = elements?.filter(isDrawable) ?? [];
    if (!drawable.length) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const element of drawable) {
      minX = Math.min(minX, element.x);
      minY = Math.min(minY, element.y);
      maxX = Math.max(maxX, element.x + element.width);
      maxY = Math.max(maxY, element.y + element.height);
    }

    // A single element, or a row of them, gives one dimension zero extent.
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = (1 - PADDING * 2) * 100;

    return {
      count: drawable.length,
      shapes: drawable.slice(0, MAX_SHAPES).map((element) => {
        const hairline = element.type === "line" || element.type === "arrow";

        return {
          left: PADDING * 100 + ((element.x - minX) / spanX) * scale,
          top: PADDING * 100 + ((element.y - minY) / spanY) * scale,
          width: Math.max((element.width / spanX) * scale, 1.5),
          height: Math.max(
            (element.height / spanY) * scale,
            hairline ? 0 : 1.5,
          ),
          stroke: element.strokeColor,
          fill:
            element.backgroundColor === "transparent"
              ? "transparent"
              : element.backgroundColor,
          rounded: element.type === "ellipse",
          hairline,
        };
      }),
    };
  } catch {
    return null;
  }
};
