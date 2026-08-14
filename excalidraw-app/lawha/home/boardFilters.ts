import type { BoardListEntry } from "../../data/boards";

/**
 * Every dashboard filter, as one pure reduction over the board list.
 *
 * Lifted out of the route once folders arrived, because the filters now
 * interact: a folder is a filter like the others and combines with search, with
 * the visibility segments and with a tag. More to the point, the selection bar
 * acts on exactly what this returns — so "which boards can Delete see" needs a
 * single answer a test can ask for directly, rather than one buried in a memo.
 *
 * Split into `matchBoards` and `sortBoards` once "Most shapes" arrived, and the
 * split is load-bearing rather than tidiness: a shape count only exists after
 * the board's scene has been decrypted on this device, and decrypting boards the
 * filters were going to hide anyway would be wasted work on every keystroke. The
 * route therefore matches first, decrypts what survived, and sorts last.
 */

export type Visibility = "all" | "shared" | "private";
export type Sort = "recent" | "name" | "shapes";

/**
 * Which folder the grid is showing.
 *
 * Two cases, not three. There used to be an `{ kind: "unfiled" }` alongside
 * these, backing a sidebar row that collected every board nobody had filed —
 * a list that grows rather than shrinks and reads as a standing reproach. It is
 * gone: "All boards" shows those boards along with everything else, and taking
 * a board back *out* of a folder is "Remove from folder" in the selection bar,
 * which is the version of that gesture a keyboard can reach.
 */
export type FolderFilter = { kind: "all" } | { kind: "folder"; id: string };

export const ALL_FOLDERS: FolderFilter = { kind: "all" };
export const inFolder = (id: string): FolderFilter => ({ kind: "folder", id });

/**
 * The `<select>` value that means "no folder at all".
 *
 * One constant, exported, because there were three spellings of this idea in
 * the tree — a drag key, a filter kind and a `<select>` sentinel declared
 * *twice*, independently, in two different components — and a test pinning the
 * raw string rather than any of them. They all meant `folderId === null` at the
 * API boundary and nothing tied them together.
 */
export const NO_FOLDER = "__none";

export const isSameFolder = (a: FolderFilter, b: FolderFilter): boolean =>
  a.kind === "folder" && b.kind === "folder"
    ? a.id === b.id
    : a.kind === b.kind;

export const matchesFolder = (
  folderId: string | null,
  filter: FolderFilter,
): boolean => filter.kind === "all" || folderId === filter.id;

/**
 * The dashboard's whole filter state, sort included.
 *
 * `matchBoards` ignores `sort` and `sortBoards` ignores everything else. They
 * share one type anyway because there is one piece of state on screen and
 * splitting it in two would mean two objects to thread through the route and
 * two chances for a call site to pass yesterday's half.
 */
export interface BoardFilters {
  query: string;
  visibility: Visibility;
  tagId: string | null;
  folder: FolderFilter;
  sort: Sort;
}

/**
 * The boards a set of filters admits, in the order they arrived.
 *
 * **A search spans every folder.** That is a deliberate reversal of "a folder is
 * a filter like the others": once you are three levels deep in Platform / Sync /
 * Protocol, a search that only looks inside the folder you happen to be standing
 * in answers "no results" for a board you can see the name of. The result is a
 * global find, and the grid shows each hit's folder path so the answer to
 * "where is it, then" is on screen rather than one more click away.
 *
 * The visibility segments and the tag chip still combine with the search, since
 * neither of those is a place — narrowing a global find by "shared only" is
 * still a global find.
 */
export const matchBoards = (
  boards: readonly BoardListEntry[],
  { query, visibility, tagId, folder }: BoardFilters,
): BoardListEntry[] => {
  const needle = query.trim().toLowerCase();

  return boards.filter((board) => {
    if (
      needle &&
      !board.name.toLowerCase().includes(needle) &&
      !board.tags.some((tag) => tag.name.toLowerCase().includes(needle))
    ) {
      return false;
    }
    if (visibility === "shared" && board.linkAccess === "none") {
      return false;
    }
    if (visibility === "private" && board.linkAccess !== "none") {
      return false;
    }
    if (tagId && !board.tags.some((tag) => tag.id === tagId)) {
      return false;
    }
    // A search leaves the folder behind; see the note above.
    return needle ? true : matchesFolder(board.folderId, folder);
  });
};

/**
 * Orders the matched boards. Never mutates its input.
 *
 * `shapeCounts` is a map from board id to the number of elements this device
 * managed to decrypt, and a board **absent from it sorts last** — never as
 * zero. The distinction is the whole point: a board whose key is not on this
 * device is unknown, not empty, and sinking it below a genuinely empty board is
 * the only ordering that does not assert something false about it. The card
 * says "no key on this device" in the same slot, so the sort and the label
 * agree.
 */
export const sortBoards = (
  boards: readonly BoardListEntry[],
  sort: Sort,
  shapeCounts?: ReadonlyMap<string, number>,
): BoardListEntry[] => {
  const matches = [...boards];

  if (sort === "name") {
    return matches.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (sort === "shapes") {
    return matches.sort((a, b) => {
      const left = shapeCounts?.get(a.id);
      const right = shapeCounts?.get(b.id);
      if (left === undefined || right === undefined) {
        // Unknown sinks. Two unknowns keep the recency order between them, so
        // the tail of the list is still arranged by something rather than by
        // whichever decrypt happened to fail first.
        return left === right
          ? b.updatedAt - a.updatedAt
          : left === undefined
          ? 1
          : -1;
      }
      return right - left || b.updatedAt - a.updatedAt;
    });
  }

  return matches.sort((a, b) => b.updatedAt - a.updatedAt);
};

/** Filter then sort, for callers that do not need the counts in between. */
export const filterBoards = (
  boards: readonly BoardListEntry[],
  filters: BoardFilters,
  shapeCounts?: ReadonlyMap<string, number>,
): BoardListEntry[] =>
  sortBoards(matchBoards(boards, filters), filters.sort, shapeCounts);
