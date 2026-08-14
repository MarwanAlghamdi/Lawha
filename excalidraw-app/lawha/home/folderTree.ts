import { COLLABORATOR_PALETTE } from "@excalidraw/common";

import type { BoardListEntry, FolderSummary } from "../../data/boards";

/**
 * The folder hierarchy, as pure functions over the list the server sent.
 *
 * No React, no fetch, no DOM — the tree is the part of the dashboard most
 * likely to be wrong in a way nobody sees for a week (a subtree that quietly
 * stops rendering, a count that drifts from the grid), and every one of those
 * failures is reachable from a plain array. `folderTree.test.ts` is the point.
 *
 * Two defences run through the whole file, and neither is theoretical padding:
 *
 *  - **A folder whose parent is missing is treated as a root**, not dropped. The
 *    server promotes children before deleting a parent, so this should not
 *    happen; if it ever does, a folder full of someone's boards vanishing from
 *    the sidebar is indistinguishable from data loss, while showing it at the
 *    top level is merely untidy.
 *  - **Every walk carries a `seen` set.** The server refuses a cycle at the
 *    write, so again this should not happen; if it ever does, the difference
 *    between a guard and no guard is a wrong indent versus a hung tab.
 */

export interface FolderNode {
  folder: FolderSummary;
  /** 0 for a root folder. */
  depth: number;
  children: FolderNode[];
}

/** One row of the sidebar, once collapsed subtrees have been dropped. */
export interface FolderRow {
  folder: FolderSummary;
  depth: number;
  hasChildren: boolean;
}

const byName = (a: FolderSummary, b: FolderSummary) =>
  a.name.localeCompare(b.name);

/**
 * Roots first, each with its children nested and sorted by name.
 *
 * Sorting here rather than at every render site: the sidebar, the "Move to…"
 * picker and the subfolder tiles all show the same folders, and three
 * independent sorts is three chances for them to disagree about where a folder
 * sits.
 */
export const buildFolderTree = (
  folders: readonly FolderSummary[],
): FolderNode[] => {
  const known = new Set(folders.map((folder) => folder.id));
  const byParent = new Map<string | null, FolderSummary[]>();

  for (const folder of folders) {
    // An unknown parent is a root. See the header: showing it is untidy,
    // hiding it looks like the folder was deleted.
    const parent =
      folder.parentId !== null && known.has(folder.parentId)
        ? folder.parentId
        : null;
    const siblings = byParent.get(parent);
    if (siblings) {
      siblings.push(folder);
    } else {
      byParent.set(parent, [folder]);
    }
  }

  const seen = new Set<string>();

  const build = (parentId: string | null, depth: number): FolderNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort(byName)
      .flatMap((folder) => {
        if (seen.has(folder.id)) {
          // Only reachable from a cycle, which the server refuses. Dropping the
          // second visit terminates the walk; rendering it twice would not.
          return [];
        }
        seen.add(folder.id);
        return [
          {
            folder,
            depth,
            children: build(folder.id, depth + 1),
          },
        ];
      });

  return build(null, 0);
};

/**
 * The tree as a flat list of rows, skipping the children of collapsed folders.
 *
 * Flat because the sidebar renders one `<button>` per folder at a computed
 * indent rather than nesting DOM: nested lists put every child inside its
 * parent's click target, and a click on a child then has to stop propagating —
 * one forgotten `stopPropagation` away from selecting the parent instead.
 */
export const flattenFolderTree = (
  nodes: readonly FolderNode[],
  expanded: ReadonlySet<string>,
): FolderRow[] =>
  nodes.flatMap((node) => [
    {
      folder: node.folder,
      depth: node.depth,
      hasChildren: node.children.length > 0,
    },
    ...(expanded.has(node.folder.id)
      ? flattenFolderTree(node.children, expanded)
      : []),
  ]);

/**
 * Root → this folder, for the breadcrumb and for "Platform / Sync" labels.
 *
 * Empty when the id is unknown, which is the honest answer while a reload is in
 * flight and the folder has just been deleted somewhere else.
 */
export const pathTo = (
  folders: readonly FolderSummary[],
  folderId: string | null,
): FolderSummary[] => {
  if (folderId === null) {
    return [];
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: FolderSummary[] = [];
  const seen = new Set<string>();

  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
};

/** `folderId` and everything beneath it. Includes itself, which callers rely on. */
export const descendantIds = (
  folders: readonly FolderSummary[],
  folderId: string,
): Set<string> => {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId !== null) {
      const list = children.get(folder.parentId);
      if (list) {
        list.push(folder.id);
      } else {
        children.set(folder.parentId, [folder.id]);
      }
    }
  }

  const out = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
};

/**
 * How many boards sit in each folder **including its subfolders**.
 *
 * Derived from the board list rather than read from `FolderSummary.boardCount`,
 * which counts direct children only. The deeper reason is that a count computed
 * from the same array the grid renders cannot disagree with the grid — and a
 * folder chip that says "3" over an empty page is a bug the user can neither
 * explain nor clear. The server's count keeps its own job: it is the one that
 * knows about access, and the list it feeds is already filtered by it.
 */
export const subtreeCounts = (
  folders: readonly FolderSummary[],
  boards: readonly BoardListEntry[],
): Map<string, number> => {
  const parentOf = new Map(
    folders.map((folder) => [folder.id, folder.parentId]),
  );
  const counts = new Map<string, number>();

  for (const board of boards) {
    let current = board.folderId;
    const seen = new Set<string>();
    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current);
      counts.set(current, (counts.get(current) ?? 0) + 1);
      current = parentOf.get(current) ?? null;
    }
  }

  return counts;
};

/**
 * Would filing `folderId` under `parentId` make it its own ancestor?
 *
 * The client half of a rule the server also enforces, and it exists for the
 * reason invariant 24 gives: the client must know what the server will refuse.
 * A drag that is going to come back 409 should not be offered as a drop target
 * in the first place — the alternative is an animation that completes, a folder
 * that snaps back, and no explanation.
 */
export const wouldCycle = (
  folders: readonly FolderSummary[],
  folderId: string,
  parentId: string | null,
): boolean =>
  parentId !== null && descendantIds(folders, folderId).has(parentId);

/**
 * The colour a folder paints its dot and its tile with.
 *
 * `COLLABORATOR_PALETTE`, not a palette of its own: those twelve were chosen so
 * a filled chip clears WCAG AA in *both* themes, which is exactly the job here,
 * and a second palette would be a second thing to re-verify. `hex` and never
 * `hexDark` — a folder tile is DOM, and only the interactive canvas is
 * colour-filtered in dark mode.
 *
 * A folder nobody has coloured gets the muted token rather than index 0, so
 * "no colour chosen" and "blue" stay tellable apart.
 */
export const FOLDER_COLOR_COUNT = COLLABORATOR_PALETTE.length;

/** What an unset — or unrecognised — colour paints as. */
export const NO_FOLDER_COLOR = "var(--lw-muted3)";

export const folderColor = (colorIndex: number | null): string => {
  if (colorIndex === null) {
    return NO_FOLDER_COLOR;
  }
  // Total, with no `!`. The index arrives from the server, which bounds it to
  // 0-255 rather than to this palette's length precisely so a thirteenth colour
  // can ship without a migration — so an index this build has never heard of is
  // an expected input, not a bug, and the fallback is what the comment above
  // promises. A negative index would also make `%` return a negative and index
  // nothing; asserting non-null here is how that became a blank dashboard
  // behind an error boundary rather than a grey dot.
  const entry = COLLABORATOR_PALETTE[colorIndex % COLLABORATOR_PALETTE.length];
  return entry ? entry.hex : NO_FOLDER_COLOR;
};
