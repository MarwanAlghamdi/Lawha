import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { generateBoardId } from "../../data";
import {
  createBoard,
  createFolder,
  createTag,
  deleteTag,
  renameTag,
  updateTag,
  deleteBoard,
  deleteFolder,
  duplicateBoard,
  listBoards,
  listFolders,
  listTags,
  moveFolder,
  renameBoard,
  renameFolder,
  setBoardFolder,
  setBoardTags,
  updateFolder,
} from "../../data/boards";
import {
  forgetBoardKey,
  rememberBoardKey,
  resolveBoardKey,
} from "../../data/boardKeys";
import { clearBoardCache } from "../../data/currentBoard";
import { clearHistoryForBoard } from "../../data/undoHistory";

import { useAppTheme } from "../../useHandleAppTheme";
import { useLawhaSession } from "../auth/useLawhaSession";
import {
  LAWHA_CONTACT_CHANNEL,
  LAWHA_CONTACT_HANDLE,
  LAWHA_CONTACT_PROMPT,
  hasLawhaContact,
} from "../contact";

import { tagColor } from "./tagColor";

import { ALL_FOLDERS, inFolder, matchBoards, sortBoards } from "./boardFilters";
import {
  NO_SELECTION,
  isEverySelected,
  pruneSelection,
  selectAll,
  selectRange,
  toggleSelected,
} from "./boardSelection";
import { forgetBoardThumbnail } from "./boardThumbnail";
import {
  exportBoards,
  importBoardsFromFiles,
  isCancellation,
} from "./boardTransfer";
import {
  buildFolderTree,
  pathTo,
  subtreeCounts,
  wouldCycle,
} from "./folderTree";
import { LawhaBoardCard } from "./LawhaBoardCard";
import { LawhaBoardRow } from "./LawhaBoardRow";
import { LawhaExportModal } from "./LawhaExportModal";
import { LawhaFolderSidebar } from "./LawhaFolderSidebar";
import { LawhaFolderTile } from "./LawhaFolderTile";
import { LawhaHomeBar } from "./LawhaHomeBar";
import { LawhaImportModal } from "./LawhaImportModal";
import { LawhaSelectionBar } from "./LawhaSelectionBar";
import { LawhaTagModal } from "./LawhaTagModal";
import { LawhaTrash } from "./LawhaTrash";
import { LawhaTransferReport } from "./LawhaTransferReport";
import { useBoardDrag } from "./useBoardDrag";
import { shapeCountsOf, useBoardThumbnails } from "./useBoardThumbnails";

import "./LawhaHome.scss";

import type { FolderOption } from "./LawhaSelectionBar";
import type { DragKind, DropTarget } from "./useBoardDrag";
import type { FolderFilter, Sort, Visibility } from "./boardFilters";
import type { TransferReport } from "./boardTransfer";
import type {
  BoardList,
  BoardListEntry,
  FolderSummary,
  TagSummary,
} from "../../data/boards";

const EMPTY: BoardList = { boards: [], editing: {} };

/**
 * The floor between two refreshes of the board list.
 *
 * Returning to the tab fires `focus` and `visibilitychange` back to back, and
 * dismissing a modal fires `focus` again on top of that. Without a floor, one
 * glance at the dashboard costs three identical round trips.
 */
const REFRESH_MIN_INTERVAL_MS = 3_000;

/** Which transient card is open over the grid, if any. */
type Modal =
  | { kind: "import" }
  | { kind: "export" }
  /** `boardId: null` is "manage my tags", with no board to label. */
  | { kind: "tags"; boardId: string | null };

/**
 * The board dashboard.
 *
 * Reads three things and joins them: the board list, the tag list and the
 * folder list. There is no fourth — this used to read which boards the browser
 * held keys for and padlock the rest, and a board it can list is now a board it
 * can open.
 *
 * One thing IS read here that the server does not supply: the shape count of
 * every visible board. `useBoardThumbnails` owns it, and it lives
 * at this level rather than in the card because the same number feeds the "Most
 * shapes" sort — a sort cannot ask each card what it happens to have decrypted.
 *
 * Laid out as the Library design does: one bar, a breadcrumb, then a sticky
 * folder tree beside a column holding the toolbar, the subfolder tiles and the
 * boards. Deliberately *not* wrapped in `LawhaPageShell` — that shell is a thin
 * header over a dotted backdrop, built for the auth cards, and the dashboard
 * carries its own bar.
 *
 * Import, Export and Tags are modals over a scrim; the selection bar floats at
 * the bottom. Both are reversals of this file's older "everything in the
 * column" rule, and both are dashboard-only — the canvas chrome is untouched.
 * ADR 0007 has the reasoning. None of them is a native dialog (invariant 19).
 */
export const HomeRoute = () => {
  const navigate = useNavigate();
  const { user, signOut } = useLawhaSession();
  const { editorTheme, setAppTheme } = useAppTheme();

  const [list, setList] = useState<BoardList>(EMPTY);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  /*
   * There is no `openable` set any more, and its absence is the fix.
   *
   * The dashboard used to join the board list against which boards this
   * browser held keys for, and draw a padlock over the difference. Two sets, a
   * union, a ticket to order the writers, and an effect keyed on the escrow
   * state — all of it existed to keep that join from re-locking cards it had
   * just unlocked, and none of it should have been needed. **A board this
   * account can see is a board it can open** (ADR 0012); the list is already
   * the authorization answer, so there is nothing left to join it against.
   */
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [transferring, setTransferring] = useState<"import" | "export" | null>(
    null,
  );
  const [report, setReport] = useState<TransferReport | null>(null);
  /**
   * A bulk delete or move is in flight.
   *
   * Separate from `transferring`, which only ever meant import or export. The
   * selection bar was locked on `transferring` alone, so delete and move ran
   * with their own buttons still live: a second click started a second pass
   * over a selection the first pass was halfway through deleting.
   */
  const [isBulkRunning, setIsBulkRunning] = useState(false);

  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderFilter>(ALL_FOLDERS);
  /**
   * Whether the grid has been replaced by the trash (ADR 0029).
   *
   * A boolean beside `folder` rather than a third `FolderFilter` variant. The
   * trash is a different list — different endpoint, rows that are not
   * `BoardListEntry` — and putting it in the filter union would have carried a
   * trashed board into `matchBoards`, `sortBoards`, the selection bar and the
   * drag handlers, every one of which is one missing `case` away from showing
   * a deleted board on the dashboard or acting on one.
   */
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [modal, setModal] = useState<Modal | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  /** The last board picked, which a shift-click measures its range from. */
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // Tags and folders degrade to empty rather than taking the page down with
      // them — neither is what the dashboard is for.
      const [boards, loadedTags, loadedFolders] = await Promise.all([
        listBoards(),
        listTags().catch(() => [] as TagSummary[]),
        listFolders().catch(() => [] as FolderSummary[]),
      ]);
      setList(boards);
      setTags(loadedTags);
      setFolders(loadedFolders);

      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load your boards.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Re-read the boards whenever this tab comes back to the front.
   *
   * The mount effect above used to be the only call, so the dashboard was a
   * snapshot of the moment it was opened. A rename, a new board, a folder move
   * or a share change made in the other tab, on the phone, or by anyone else on
   * the team never arrived — the page just kept showing yesterday, and the only
   * way to find out was to reload it by hand.
   *
   * Focus and visibility rather than a poll or a socket: the dashboard is a page
   * you *arrive* at, and arriving is the event. A timer would spend requests on
   * a tab nobody is looking at, and a live channel would be a second source of
   * truth for data the REST list already owns.
   *
   * The guard is what keeps this honest. Alt-tabbing fires `focus` and
   * `visibilitychange` together, and a modal closing can fire `focus` again, so
   * without a floor this would be three round trips for one glance.
   */
  useEffect(() => {
    let lastAt = Date.now();

    const refresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (now - lastAt < REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      lastAt = now;
      void reload();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  // --- the tree ------------------------------------------------------------

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  /**
   * Board totals per folder, subfolders included, derived from the very array
   * the grid renders — so a count and the page under it cannot disagree.
   */
  const counts = useMemo(
    () => subtreeCounts(folders, list.boards),
    [folders, list.boards],
  );

  /**
   * "Platform / Sync engine" for a folder, an em dash for a board in none.
   *
   * The dash rather than a word. This is a *cell* in the Details view and an
   * option label in two pickers, and any word here — "Unfiled", "None" — reads
   * as the name of a folder that boards have been put into, which is the exact
   * misreading the sidebar row used to produce. A dash reads as an absence.
   */
  const pathLabel = useCallback(
    (folderId: string | null): string =>
      folderId === null
        ? "—"
        : pathTo(folders, folderId)
            .map((entry) => entry.name)
            .join(" / ") || "—",
    [folders],
  );

  const folderOptions = useMemo<FolderOption[]>(
    () =>
      folders
        .map((entry) => ({ id: entry.id, label: pathLabel(entry.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [folders, pathLabel],
  );

  const activeFolderId = folder.kind === "folder" ? folder.id : null;

  /** The folders directly inside the one being shown, as tiles above the grid. */
  const subfolders = useMemo(
    () =>
      folders
        .filter((entry) => entry.parentId === activeFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, activeFolderId],
  );

  // --- filtering, then decrypting, then sorting ----------------------------

  const isSearching = query.trim().length > 0;

  const matched = useMemo(
    () =>
      matchBoards(list.boards, {
        query,
        visibility,
        tagId: activeTagId,
        folder,
        sort,
      }),
    [list.boards, query, visibility, activeTagId, folder, sort],
  );

  // Only what survived the filters is decrypted: a search that hides ninety
  // boards should not spend ninety decrypts on them.
  const thumbnails = useBoardThumbnails(matched);
  const shapeCounts = useMemo(() => shapeCountsOf(thumbnails), [thumbnails]);

  const visible = useMemo(
    () => sortBoards(matched, sort, shapeCounts),
    [matched, sort, shapeCounts],
  );

  const visibleIds = useMemo(() => visible.map((board) => board.id), [visible]);

  // The selection follows the grid. A board taken off screen by a filter, a
  // folder or a delete leaves the selection with it, so "3 selected" always
  // means three boards you can point at — Delete is not an action to aim blind.
  // `pruneSelection` hands back the same set when nothing changed, which is what
  // keeps this from setting state on every render.
  useEffect(() => {
    setSelected((current) => pruneSelection(current, visibleIds));
  }, [visibleIds]);

  const selectedBoards = useMemo(
    () => visible.filter((board) => selected.has(board.id)),
    [visible, selected],
  );

  const everySelected = isEverySelected(selected, visibleIds);

  const onToggleSelect = (board: BoardListEntry, extend: boolean) => {
    setSelected((current) =>
      extend
        ? selectRange(current, visibleIds, anchorId, board.id)
        : toggleSelected(current, board.id),
    );
    setAnchorId(board.id);
  };

  const onSelectAll = () => {
    setSelected(everySelected ? NO_SELECTION : selectAll(visibleIds));
    setAnchorId(null);
  };

  const clearSelection = () => {
    setSelected(NO_SELECTION);
    setAnchorId(null);
  };

  /** Everyone on any board right now — what the bar's live dot counts. */
  const live = useMemo(
    () => Object.values(list.editing).reduce((total, n) => total + n, 0),
    [list.editing],
  );

  // --- boards --------------------------------------------------------------

  const onNewBoard = async () => {
    try {
      // An id, and nothing else. This used to mint a room key alongside it,
      // store it locally *before* the board row existed, and then escrow it
      // *after* — an ordering that existed because the escrow write was
      // authorised against a board the server had to have heard of already,
      // and which was a race the code usually won and silently lost the rest
      // of the time. A board created now is plaintext from its first save, so
      // there is no key, no ordering and no race (ADR 0012).
      const roomId = await generateBoardId();
      await createBoard({ id: roomId, name: "Untitled" });
      // Created inside the folder you are standing in, which is what "New
      // board" in an open folder plainly means.
      if (activeFolderId) {
        await setBoardFolder(roomId, activeFolderId).catch(() => undefined);
      }
      navigate(`/b/${roomId}`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create a board.",
      );
    }
  };

  /**
   * Export the selected boards.
   *
   * Partial by construction, and the partiality is the thing that must not be
   * hidden: a board is ciphertext plus a key that lives only on the devices its
   * share link has reached, so selecting five boards on a device holding three
   * keys can only ever produce three. The other two are named in the report.
   * Dropping them quietly would hand someone a backup with holes in it that
   * they discover the day they need it.
   */
  const onExportSelected = async () => {
    setTransferring("export");
    setReport(null);
    try {
      const result = await exportBoards(selectedBoards);
      setModal(null);
      setReport(result);
    } catch (caught) {
      if (!isCancellation(caught)) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not export those boards.",
        );
      }
    } finally {
      setTransferring(null);
    }
  };

  /**
   * Import `.excalidraw` files, or a bundle this dashboard wrote earlier.
   *
   * Each file lands as a brand-new board with a brand-new key. Filing is a
   * second call per board rather than part of the import, because the import is
   * the irreversible half and must not be held up by it — a board that imported
   * and failed to file is a board in the unfiled pile, which is recoverable; the
   * reverse is not.
   */
  const onImport = async (files: File[], folderId: string | null) => {
    setReport(null);
    setTransferring("import");
    try {
      const result = await importBoardsFromFiles(files);
      setModal(null);
      setReport(result);

      if (folderId) {
        for (const boardId of result.importedIds) {
          await setBoardFolder(boardId, folderId).catch(() => undefined);
        }
      }
      if (result.imported.length) {
        if (folderId) {
          setFolder(inFolder(folderId));
        }
        await reload();
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not import the files.",
      );
    } finally {
      setTransferring(null);
    }
  };

  // The card owns the rename input and the delete confirmation. They were
  // `window.prompt` and `window.confirm`, which this product does not get to
  // use: everything lives inside its own chrome, and a native dialog blocks the
  // renderer besides — the same failure that froze this route once already.
  const onRename = async (board: BoardListEntry, name: string) => {
    try {
      await renameBoard(board.id, name);
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not rename it.",
      );
    }
  };

  const onDuplicate = async (board: BoardListEntry) => {
    try {
      // The key, if this board still has one, is resolved BEFORE the copy.
      //
      // The server copies the stored scene verbatim, so a copy of a board that
      // is still ciphertext is readable only under its *source's* key. That is
      // how this deployment ended up with a 12 KB board called "Do not touch
      // copy" that nobody could open — and, later, how it was recovered, since
      // the source's key opened the copy too.
      //
      // A miss no longer aborts. It used to, because every board had a key and
      // a duplicate without one was unopenable; a board created since ADR 0012
      // has no key at all and its copy is plaintext, so refusing would block
      // the ordinary case to guard the vanishing one.
      const key = await resolveBoardKey(board.id, null);
      const copy = await duplicateBoard(board.id);
      if (key) {
        await rememberBoardKey(copy.id, key);
      }
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not duplicate it.",
      );
    }
  };

  /**
   * The local traces a delete may take, because the server can hand them back.
   *
   * **Split out of `forgetLocally` when the trash arrived (ADR 0029), and the
   * split is the whole safety of the feature.** This used to be one function
   * that ran on delete and threw away four things. Two of them the server can
   * reproduce on the next open — the scene cache and the thumbnail are both
   * derived from the board's own scene — and two of them it cannot:
   *
   *  - `forgetBoardKey` is, for the handful of boards still stored as
   *    ciphertext, the **last copy in existence** (see `data/boardKeys.ts`).
   *    Dropping it on a soft delete would mean restore returned a board that
   *    opens to nothing, permanently, and the dashboard would show it as a
   *    perfectly normal board while it did.
   *  - the undo history lives only in this browser (ADR 0019). Nothing on the
   *    server has a copy, so a delete-then-restore would silently take work
   *    the user never asked to lose.
   *
   * Neither belongs on a path whose entire point is that it can be undone. The
   * privacy reasoning of the original comment survives intact for the two that
   * stay here: the local scene copy is cleared at the moment the board leaves
   * the dashboard, and it costs nothing, because a restore rebuilds it.
   */
  const forgetRebuildable = (board: BoardListEntry) => {
    clearBoardCache(board.id);
    forgetBoardThumbnail(board.id);
  };

  /**
   * Everything this browser holds about a board that is gone for good.
   *
   * Reached only from the trash's "Delete for ever", which is the point at
   * which the server has genuinely destroyed the board and there is nothing
   * left to restore from — so keeping the key or the history would be keeping
   * a copy of a deleted board in the browser for ever, which is the thing the
   * original version of this function existed to prevent.
   *
   * `clearHistoryForBoard` is not keyed to the signed-in account: it takes
   * every account's copy in this browser, because the board is gone
   * server-side for all of them (ADR 0019's Risk 4, on the delete path).
   */
  const forgetLocally = async (boardId: string) => {
    await forgetBoardKey(boardId);
    clearBoardCache(boardId);
    forgetBoardThumbnail(boardId);
    await clearHistoryForBoard(boardId);
  };

  const onDelete = async (board: BoardListEntry) => {
    try {
      await deleteBoard(board.id);
      // Rebuildable traces only. See `forgetRebuildable` — a delete is now
      // reversible for thirty days, and a reversible delete must not destroy
      // the two things the server cannot give back.
      forgetRebuildable(board);
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not delete it.",
      );
    }
  };

  /**
   * Delete every selected board, one at a time, naming the ones that survived.
   *
   * Sequential and individually guarded on purpose. A bulk action that stops at
   * the first refusal leaves the user with no idea which half went, and one
   * that reports "something went wrong" is barely better — the boards that
   * could not be deleted are listed by name, the same contract the transfer
   * report holds itself to.
   */
  const onDeleteSelected = async () => {
    const failed: string[] = [];

    for (const board of selectedBoards) {
      try {
        await deleteBoard(board.id);
        forgetRebuildable(board);
      } catch {
        failed.push(board.name);
      }
    }

    clearSelection();
    setError(
      failed.length
        ? `These could not be deleted: ${failed.join(", ")}.`
        : null,
    );
    await reload();
  };

  /**
   * File boards, or clear their filing with `null`.
   *
   * Filing is per person, so each board is its own PATCH and its own possible
   * refusal — a board someone revoked since the list loaded fails while the
   * rest succeed. Named, not summarised, for the same reason as above.
   */
  const moveBoards = async (
    boardIds: readonly string[],
    folderId: string | null,
  ) => {
    const failed: string[] = [];
    const nameOf = (id: string) =>
      list.boards.find((board) => board.id === id)?.name ?? id;

    for (const boardId of boardIds) {
      try {
        await setBoardFolder(boardId, folderId);
      } catch {
        failed.push(nameOf(boardId));
      }
    }

    setError(
      failed.length ? `These could not be moved: ${failed.join(", ")}.` : null,
    );
    await reload();
  };

  const onMoveSelected = (folderId: string | null) =>
    moveBoards(
      selectedBoards.map((board) => board.id),
      folderId,
    );

  /**
   * Runs one bulk action with the selection bar locked for its duration.
   *
   * Wrapped at the call site rather than inside each handler, so that
   * `onMoveToNewFolder` — which creates a folder and then moves into it — stays
   * one action holding one lock instead of nesting two.
   */
  const runBulk = async (action: () => Promise<void>) => {
    setIsBulkRunning(true);
    try {
      await action();
    } finally {
      setIsBulkRunning(false);
    }
  };

  /** One intention, one step: nobody opens that row wanting an empty folder. */
  const onMoveToNewFolder = async (name: string) => {
    try {
      const created = await createFolder(name, { parentId: activeFolderId });
      await onMoveSelected(created.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not create that folder.",
      );
    }
  };

  // --- folders -------------------------------------------------------------

  const guard = async (action: () => Promise<unknown>, whenItFails: string) => {
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : whenItFails);
    }
  };

  const onCreateFolder = (name: string, parentId: string | null) =>
    guard(async () => {
      const created = await createFolder(name, { parentId });
      if (parentId) {
        setExpanded((current) => new Set(current).add(parentId));
      }
      setFolder(inFolder(created.id));
    }, "Could not create that folder.");

  const onRenameFolder = (folderId: string, name: string) =>
    guard(() => renameFolder(folderId, name), "Could not rename that folder.");

  const onRecolourFolder = (folderId: string, colorIndex: number | null) =>
    guard(
      () => updateFolder(folderId, { colorIndex }),
      "Could not change that colour.",
    );

  const onMoveFolder = (folderId: string, parentId: string | null) =>
    guard(async () => {
      await moveFolder(folderId, parentId);
      if (parentId) {
        setExpanded((current) => new Set(current).add(parentId));
      }
    }, "Could not move that folder.");

  const onDeleteFolder = (folderId: string) =>
    guard(async () => {
      await deleteFolder(folderId);
      // Its contents moved up a level; the grid has to stop filtering by a
      // folder that no longer exists, or it would show an empty page and read
      // as though the boards went with it.
      if (folder.kind === "folder" && folder.id === folderId) {
        const parent = folders.find((entry) => entry.id === folderId)?.parentId;
        setFolder(parent ? inFolder(parent) : ALL_FOLDERS);
      }
    }, "Could not delete that folder.");

  // --- drag and drop -------------------------------------------------------

  /**
   * One handler for both kinds of drop.
   *
   * Boards and folders used to arrive through two entirely separate drag
   * implementations — boards on the shared hook, folders on a hand-rolled
   * HTML5 drag inside the sidebar, with their own hit-testing and their own
   * over-state. They share one now, so this is where they part company again:
   * once, at the end, where the two outcomes actually differ.
   */
  const onDropped = useCallback(
    (kind: DragKind, target: DropTarget, ids: readonly string[]) => {
      if (kind === "folder") {
        const [folderId] = ids;
        if (folderId) {
          void onMoveFolder(folderId, target);
        }
        return;
      }

      // A board has nowhere to land but a folder — the top-level tail refuses
      // board drags — so `null` cannot reach here.
      if (target === null) {
        return;
      }

      void runBulk(async () => {
        await moveBoards(ids, target);
        // The dragged boards were only selected if the drag started from a
        // selection; either way the move is done and leaving them picked would
        // arm Delete on boards that have just moved out of view.
        clearSelection();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list.boards],
  );

  /**
   * A folder cannot be dropped into itself or into its own subtree.
   *
   * Answered here, at hit-test time, rather than rendered into an attribute:
   * whether a target may take this drag depends on which folder is in the air,
   * and that is not known when the row is drawn. Checked on the client at all —
   * rather than left to the server's 409 — because invariant 24 says the client
   * must know what the server will refuse. Otherwise the drop completes, the
   * folder snaps back, and nothing anywhere says why.
   */
  const canDrop = useCallback(
    (kind: DragKind, target: DropTarget, ids: readonly string[]) => {
      if (kind !== "folder") {
        return true;
      }
      const [folderId] = ids;
      return (
        !!folderId &&
        folderId !== target &&
        !wouldCycle(folders, folderId, target)
      );
    },
    [folders],
  );

  const drag = useBoardDrag({ selected, onDrop: onDropped, canDrop });

  // --- tags ----------------------------------------------------------------

  /**
   * Whether the tag modal is open, and which board it is labelling.
   *
   * Two facts, because they are now independent: the modal opens with no board
   * from the dashboard's Tags button. Folding them into one nullable board
   * would make "manage my tags" indistinguishable from "the board went away
   * while the modal was open", and the second should close it.
   */
  const isTagModalOpen = modal?.kind === "tags";
  const tagBoard =
    isTagModalOpen && modal.boardId !== null
      ? list.boards.find((board) => board.id === modal.boardId) ?? null
      : null;

  const onToggleTag = (board: BoardListEntry, tagId: string) =>
    guard(() => {
      const next = board.tags.some((tag) => tag.id === tagId)
        ? board.tags.filter((tag) => tag.id !== tagId).map((tag) => tag.id)
        : [...board.tags.map((tag) => tag.id), tagId];
      return setBoardTags(board.id, next);
    }, "Could not change those tags.");

  /**
   * `board` is NULLABLE, and that is the whole of this fix.
   *
   * The dashboard's own Tags button opens the modal with no board — that is
   * what management mode is — and the JSX below used to read
   * `tagBoard && onCreateTag(tagBoard, name)`. With no board the `&&`
   * short-circuited, this function was never called, and creating a tag from
   * the Tags button did nothing at all: no request, no error, nothing to see.
   * The modal clears its own input on submit regardless of what the handler
   * does, so the field emptied and it read as having worked.
   *
   * Typed `| null` rather than guarded at the call site on purpose. A caller
   * that has to remember to check is the arrangement that produced the bug;
   * this way the compiler carries it.
   */
  const onCreateTag = (board: BoardListEntry | null, name: string) =>
    guard(async () => {
      // `POST /tags` is idempotent by name, so typing an existing tag attaches
      // it rather than failing — which is what someone typing it plainly means.
      const tag = await createTag(name);
      // No board is not a no-op: the tag itself is the point in management
      // mode. Only the attaching is skipped.
      if (board) {
        await setBoardTags(board.id, [
          ...board.tags.map((entry) => entry.id),
          tag.id,
        ]);
      }
    }, "Could not add that tag.");

  const onRenameTag = (tagId: string, name: string) =>
    guard(async () => {
      // Renames the tag itself, so every board carrying it is relabelled. The
      // server refuses a name another tag already has (409 TAG_TAKEN), because
      // two tags reading identically are indistinguishable to whoever is
      // filtering by one.
      await renameTag(tagId, name);
    }, "Could not rename that tag.");

  const onRecolourTag = (tagId: string, colorIndex: number | null) =>
    guard(async () => {
      // The colour is on the tag, not on the board, so this repaints every
      // board carrying it — the same shape as the rename above and for the
      // same reason: a tag is one row that many boards point at.
      await updateTag(tagId, { colorIndex });
    }, "Could not change that tag's colour.");

  const onDeleteTag = (tagId: string) =>
    guard(async () => {
      // `board_tags` cascades, so this unlabels boards and never deletes one.
      // Worth knowing before reading the confirm copy in the modal, which says
      // "from every board" rather than "delete tag" for exactly that reason.
      await deleteTag(tagId);
      // Clear the filter if it was pointing at the tag that just went, or the
      // grid would show an empty result for something no longer selectable.
      setActiveTagId((current) => (current === tagId ? null : current));
    }, "Could not delete that tag.");

  // --- render --------------------------------------------------------------

  /**
   * The path to the folder being shown, root first, empty at "All boards".
   *
   * This *is* the heading now. There used to be a breadcrumb strip of its own
   * above the sidebar and a plain `<h1>` below it, so the page said where you
   * were three times — twice in writing and once as a highlighted row in the
   * tree — before it said anything about a board. Folding the two together
   * removes a strip, removes the "All boards" crumb that only ever duplicated
   * the row already sitting at the top of the sidebar, and leaves one place to
   * look.
   */
  const path = pathTo(folders, activeFolderId);

  const cardProps = (board: BoardListEntry) => ({
    board,
    editing: list.editing[board.id] ?? 0,
    thumbnail: thumbnails.get(board.id),
    isSelected: selected.has(board.id),
    isSelecting: selected.size > 0,
    onToggleSelect: (extend: boolean) => onToggleSelect(board, extend),
    onOpen: () => navigate(`/b/${board.id}`),
    onRename: (name: string) => onRename(board, name),
    onDuplicate: () => onDuplicate(board),
    onDelete: () => onDelete(board),
    onEditTags: () => setModal({ kind: "tags", boardId: board.id }),
    drag,
  });

  return (
    <div className="lw-home">
      <LawhaHomeBar
        query={query}
        onQueryChange={setQuery}
        live={live}
        user={user}
        editorTheme={editorTheme}
        onThemeChange={setAppTheme}
        onOpenAccount={() => navigate("/account")}
        onSignOut={async () => {
          await signOut();
          navigate("/signin");
        }}
        onNewBoard={onNewBoard}
        onImport={() => setModal({ kind: "import" })}
        onManageTags={() => setModal({ kind: "tags", boardId: null })}
        transferring={transferring}
      />

      <div className="lw-home__body">
        <LawhaFolderSidebar
          folders={folders}
          tree={tree}
          counts={counts}
          active={folder}
          allCount={list.boards.length}
          expanded={expanded}
          onToggleExpanded={(folderId) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (!next.delete(folderId)) {
                next.add(folderId);
              }
              return next;
            })
          }
          onSelect={(next) => {
            // Picking a folder is how you leave the trash. Without this the
            // column would highlight a folder while the trash stayed on
            // screen — the sidebar describing a grid that is not there.
            setIsTrashOpen(false);
            setFolder(next);
          }}
          onCreate={onCreateFolder}
          onRename={onRenameFolder}
          onRecolour={onRecolourFolder}
          onDelete={onDeleteFolder}
          drag={drag}
          isTrashActive={isTrashOpen}
          onSelectTrash={() => setIsTrashOpen(true)}
        />

        {isTrashOpen ? (
          <div className="lw-home__main">
            <LawhaTrash
              onRestored={() => {
                void reload();
              }}
              onPurged={forgetLocally}
            />
          </div>
        ) : (
          <div className="lw-home__main">
            <div className="lw-home__toolbar">
              {/*
              The heading is the path. Ancestors are buttons and drop targets;
              the folder you are standing in is plain text inside the same
              heading, so the whole thing reads as one line to a screen reader
              rather than as a list of links with a title bolted on.
            */}
              <h1 className="lw-home__heading">
                {isSearching ? (
                  `Results for “${query.trim()}”`
                ) : path.length === 0 ? (
                  "All boards"
                ) : (
                  <>
                    {path.map((entry, index) =>
                      index === path.length - 1 ? (
                        <span
                          key={entry.id}
                          className="lw-home__crumb--current"
                        >
                          {entry.name}
                        </span>
                      ) : (
                        <span key={entry.id}>
                          <button
                            type="button"
                            className={`lw-home__crumb${
                              drag.isOver(entry.id)
                                ? " lw-home__crumb--over"
                                : ""
                            }`}
                            onClick={() => setFolder(inFolder(entry.id))}
                            {...drag.targetProps(entry.id)}
                          >
                            {entry.name}
                          </button>
                          <span
                            className="lw-home__crumb-sep"
                            aria-hidden="true"
                          >
                            ›
                          </span>
                        </span>
                      ),
                    )}
                  </>
                )}
              </h1>

              <div className="lw-home__tools">
                <div
                  className="lw-home__views"
                  role="radiogroup"
                  aria-label="How to show the boards"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view === "grid"}
                    className={`lw-home__view${
                      view === "grid" ? " lw-home__view--on" : ""
                    }`}
                    onClick={() => setView("grid")}
                  >
                    Tiles
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view === "list"}
                    className={`lw-home__view${
                      view === "list" ? " lw-home__view--on" : ""
                    }`}
                    onClick={() => setView("list")}
                  >
                    Details
                  </button>
                </div>

                <div
                  className="lw-home__segmented"
                  role="radiogroup"
                  aria-label="Which boards"
                >
                  {(["all", "shared", "private"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={visibility === option}
                      className={`lw-home__segment${
                        visibility === option ? " lw-home__segment--on" : ""
                      }`}
                      onClick={() => setVisibility(option)}
                    >
                      {option === "all" ? `All ${list.boards.length}` : option}
                    </button>
                  ))}
                </div>

                <select
                  className="lw-select lw-home__sort"
                  aria-label="Sort boards"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as Sort)}
                >
                  <option value="recent">Last edited</option>
                  <option value="name">Name A–Z</option>
                  <option value="shapes">Most shapes</option>
                </select>

                {/*
                The way to widen a selection, and the way out of one — not the
                way into one.

                It used to render on every non-empty grid, so a dashboard
                nobody was selecting anything on carried a permanent "Select
                all 7": an offer almost nobody wants, sitting in the toolbar of
                the screen people spend the most time on. The first pick comes
                from a card's own checkbox now, and this appears once there is
                a selection for it to be about.

                Still reads "Clear" when everything on screen is already
                picked, so the label always names what the click will do.
              */}
                {visible.length > 0 && selected.size > 0 ? (
                  <button
                    type="button"
                    className="lw-btn lw-home__select-all"
                    onClick={onSelectAll}
                  >
                    {everySelected ? "Clear" : `Select all ${visible.length}`}
                  </button>
                ) : null}
              </div>
            </div>

            {/*
            One line, only when it has something to add. It used to be a
            standing paragraph of advice that never changed, sitting between the
            filters and the boards on every visit — a strip of chrome that took
            a row of grid from everyone permanently in order to tell each person
            the same thing once.
          */}
            {isSearching ? (
              <p className="lw-home__subtitle">
                Searching every folder. Each result says where it is filed.
              </p>
            ) : null}

            {tags.length > 0 ? (
              <div className="lw-home__tags">
                <span className="lw-home__tags-label">Tags</span>
                <button
                  type="button"
                  className={`lw-chip lw-home__tag${
                    activeTagId === null ? " lw-home__tag--on" : ""
                  }`}
                  onClick={() => setActiveTagId(null)}
                >
                  all
                </button>
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={`lw-chip lw-home__tag${
                      activeTagId === tag.id ? " lw-home__tag--on" : ""
                    }`}
                    style={{ color: tagColor(tag.colorIndex) }}
                    onClick={() =>
                      setActiveTagId(activeTagId === tag.id ? null : tag.id)
                    }
                  >
                    {tag.name} · {tag.boardCount}
                  </button>
                ))}
              </div>
            ) : null}

            {error ? (
              <p className="lw-inline-error" role="alert">
                {error}
              </p>
            ) : null}

            {report ? (
              <LawhaTransferReport
                report={report}
                onDismiss={() => setReport(null)}
              />
            ) : null}

            {/* Subfolders sit above the boards, so going down a level is a click
              on the thing you are looking at rather than a hunt in the tree. */}
            {!isSearching && subfolders.length > 0 ? (
              <div className="lw-home__tiles">
                <span className="lw-home__tiles-label">Subfolders</span>
                <div className="lw-home__tiles-grid">
                  {subfolders.map((entry) => (
                    <LawhaFolderTile
                      key={entry.id}
                      folder={entry}
                      count={counts.get(entry.id) ?? 0}
                      subfolderCount={
                        folders.filter((other) => other.parentId === entry.id)
                          .length
                      }
                      onOpen={() => setFolder(inFolder(entry.id))}
                      drag={drag}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {isLoading ? (
              <span className="lw-field__hint">Loading your boards…</span>
            ) : view === "list" ? (
              <div className="lw-board-list">
                <div className="lw-board-list__head" aria-hidden="true">
                  <span />
                  <span>Name</span>
                  <span>Folder</span>
                  <span>Tags</span>
                  <span>Shapes</span>
                  <span>Modified</span>
                  <span />
                </div>
                {visible.map((board) => (
                  <LawhaBoardRow
                    key={board.id}
                    {...cardProps(board)}
                    path={pathLabel(board.folderId)}
                  />
                ))}
              </div>
            ) : (
              <div className="lw-home__grid">
                {visible.map((board) => (
                  <LawhaBoardCard
                    key={board.id}
                    {...cardProps(board)}
                    // Only under a search: inside a folder every card has the
                    // same path and repeating it on all of them is noise.
                    path={isSearching ? pathLabel(board.folderId) : null}
                  />
                ))}

                <button
                  type="button"
                  className="lw-home__new-tile"
                  onClick={onNewBoard}
                >
                  <span className="lw-home__new-tile-mark" aria-hidden="true">
                    +
                  </span>
                  <span className="lw-home__new-tile-label">Blank board</span>
                  <span className="lw-home__new-tile-note">
                    private until you send a link
                  </span>
                </button>
              </div>
            )}

            {/*
            Where to send a bug, under the last row of boards.

            In the scrolling column rather than fixed to the viewport: this is
            a note, not a control, and a permanent bar would spend real estate
            on something almost nobody needs on any given visit. Somebody who
            has finished with their boards and reached the end of the list is
            exactly who is between tasks and might actually write it down.

            The words are in `lawha/contact.ts` — one place, so a handle that
            changes changes everywhere rather than in two of the three screens
            somebody remembered.

            It first landed inside the drag ghost, which is mounted always and
            hidden until a drag starts, so it rendered and was never visible.
            `LawhaHomeContact.test.tsx` pinned that it was on screen rather than
            merely in the DOM, and went with the app suites (`59930dbf`).

            NOT RENDERED AT ALL when nobody is named, which is the shipped
            state. This is the one contact surface with no fallback sentence,
            and the asymmetry is deliberate: `/reset` and the sign-in note are
            on the path of somebody who cannot get in and must be told
            something, while this is a nicety at the bottom of a list you can
            only reach once you are already signed in. "Found a bug? Tell
            somebody." is furniture.
          */}
            {hasLawhaContact() ? (
              <footer className="lw-home__contact">
                <span>{LAWHA_CONTACT_PROMPT}</span>
                <span>
                  Message <strong>{LAWHA_CONTACT_HANDLE}</strong> on{" "}
                  {LAWHA_CONTACT_CHANNEL}.
                </span>
              </footer>
            ) : null}

            {!isLoading && list.boards.length > 0 && visible.length === 0 ? (
              <p className="lw-home__empty">
                {isSearching
                  ? "Nothing matches that search, in any folder."
                  : "Nothing here yet. Drag a board in, or make one."}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/*
        The thing you are holding.

        Always mounted, hidden by CSS until a drag starts, because the hook
        moves it by writing `transform` on the node — mounting it on drag start
        would mean the first frame is drawn wherever the layout puts it and then
        jumps to the pointer. `aria-hidden`: it is a picture of a decision that
        has not been made yet, and a screen reader is not driving this gesture
        anyway.
      */}
      <div
        ref={drag.ghostRef}
        className={`lw-drag-ghost${
          drag.isDragging ? " lw-drag-ghost--on" : ""
        }`}
        aria-hidden="true"
      >
        <span className="lw-drag-ghost__label">
          {drag.kind === "folder"
            ? folders.find((entry) => entry.id === drag.ids[0])?.name ??
              "Folder"
            : drag.ids.length === 1
            ? list.boards.find((board) => board.id === drag.ids[0])?.name ??
              "Board"
            : `${drag.ids.length} boards`}
        </span>
      </div>

      {selected.size > 0 ? (
        <LawhaSelectionBar
          count={selected.size}
          folderOptions={folderOptions}
          busy={transferring !== null || isBulkRunning}
          onExport={() => setModal({ kind: "export" })}
          onMove={(folderId) => runBulk(() => onMoveSelected(folderId))}
          onMoveToNewFolder={(name) => runBulk(() => onMoveToNewFolder(name))}
          onDelete={() => runBulk(onDeleteSelected)}
          onClear={clearSelection}
        />
      ) : null}

      {modal?.kind === "import" ? (
        <LawhaImportModal
          folderOptions={folderOptions}
          defaultFolderId={activeFolderId}
          busy={transferring !== null}
          onClose={() => setModal(null)}
          onImport={onImport}
        />
      ) : null}

      {modal?.kind === "export" ? (
        <LawhaExportModal
          boards={selectedBoards}
          busy={transferring !== null}
          onClose={() => setModal(null)}
          onExport={onExportSelected}
        />
      ) : null}

      {isTagModalOpen ? (
        <LawhaTagModal
          board={tagBoard}
          tags={tags}
          busy={isBulkRunning}
          onClose={() => setModal(null)}
          onToggle={(tagId) => tagBoard && onToggleTag(tagBoard, tagId)}
          onCreate={(name) => onCreateTag(tagBoard, name)}
          onRename={onRenameTag}
          onRecolour={onRecolourTag}
          onDelete={onDeleteTag}
        />
      ) : null}
    </div>
  );
};
