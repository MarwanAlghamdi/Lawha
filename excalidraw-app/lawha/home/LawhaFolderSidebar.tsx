import { useState } from "react";

import { COLLABORATOR_PALETTE } from "@excalidraw/common";

import { ALL_FOLDERS, inFolder, isSameFolder } from "./boardFilters";
import { flattenFolderTree, folderColor } from "./folderTree";
import { plural } from "./homeText";

import type { BoardDrag } from "./useBoardDrag";
import type { FolderFilter } from "./boardFilters";
import type { FolderNode } from "./folderTree";
import type { FolderSummary } from "../../data/boards";

interface LawhaFolderSidebarProps {
  folders: FolderSummary[];
  /** Built once by the route and shared with the tiles and the "Move to" picker. */
  tree: FolderNode[];
  /** Board totals including subfolders, derived from the list the grid renders. */
  counts: ReadonlyMap<string, number>;
  active: FolderFilter;
  allCount: number;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (folderId: string) => void;
  onSelect: (filter: FolderFilter) => void;
  /** `parentId` is the folder currently open, so "New folder" nests where you are. */
  onCreate: (name: string, parentId: string | null) => void;
  onRename: (folderId: string, name: string) => void;
  onRecolour: (folderId: string, colorIndex: number | null) => void;
  // Re-parenting is a drop, and the route owns drops now — a folder landing on
  // a folder and a board landing on a folder arrive through the same handler,
  // so this column no longer needs its own way to ask for one.
  /** Only called once the sidebar's own confirm step has been accepted. */
  onDelete: (folderId: string) => void;
  /** Boards being dragged, so every row can be a drop target. */
  drag: BoardDrag;
  /**
   * Whether the grid has been replaced by the trash (ADR 0029).
   *
   * Passed in rather than derived from `active`, because the trash is not a
   * folder filter — it is a different list, from a different endpoint, of rows
   * that are not `BoardListEntry` at all. Widening `FolderFilter` with a third
   * variant would have put a trashed board inside `matchBoards`, one missed
   * `case` away from appearing on the dashboard.
   *
   * It still has to reach this column, because while the trash is showing NO
   * folder row may look selected. Leaving "All boards" lit under a screen full
   * of deleted boards is the exact shape invariant 7 warns about — the sidebar
   * still describing a grid that is no longer there.
   */
  isTrashActive: boolean;
  onSelectTrash: () => void;
}

/** Idle, naming a new folder, renaming one in place, or confirming a delete. */
type SidebarMode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "renaming"; id: string }
  | { kind: "confirming"; id: string };

const IDLE: SidebarMode = { kind: "idle" };

/** Hoisted so the row's props keep a stable identity across renders. */
const BOARD_OR_FOLDER = ["board", "folder"] as const;
const FOLDER_ONLY = ["folder"] as const;

/**
 * The folder tree: "All boards", the hierarchy, "+ New folder".
 *
 * There is no "Unfiled" row. It was a place that held everything nobody had
 * filed, which meant it grew rather than shrank and read as a chore list — and
 * "All boards" already shows those boards, alongside everything else. Taking a
 * board back out of a folder is "Remove from folder" in the selection bar,
 * which is the version of that gesture a keyboard can reach.
 *
 * A sticky column rather than a row of chips, because folders nest now and a
 * chip cannot show depth. Every folder row is a drop target for boards, and
 * every folder row is itself draggable onto another — which is the only way to
 * re-parent a folder, since there is no "move folder to…" menu anywhere.
 *
 * Rendered flat, at a computed indent, rather than as nested lists. Nesting the
 * DOM would put each child inside its parent's click target and leave every
 * child click one forgotten `stopPropagation` away from selecting the parent
 * instead.
 *
 * Creating, renaming, recolouring and deleting all happen right here in the
 * column. No native dialog on any path (invariant 19): the rename input
 * replaces the row where it stands, committing on Enter or blur and abandoning
 * on Escape, and an empty draft commits nothing — so a blur on an empty field
 * is a cancel rather than a folder called "".
 */
export const LawhaFolderSidebar = ({
  folders,
  tree,
  counts,
  active,
  allCount,
  expanded,
  onToggleExpanded,
  onSelect,
  onCreate,
  onRename,
  onRecolour,
  onDelete,
  drag,
  isTrashActive,
  onSelectTrash,
}: LawhaFolderSidebarProps) => {
  const [mode, setMode] = useState<SidebarMode>(IDLE);
  const [draft, setDraft] = useState("");

  /**
   * The folder in the air, if the drag is a folder drag.
   *
   * Read off the shared drag rather than kept here. This column used to run its
   * own parallel HTML5 drag for folder-onto-folder while boards came in on the
   * other one, which meant two hit-tests, two over-states and two sets of rules
   * about what a row would accept — and only one of them worked on a tablet.
   */
  const heldFolder = drag.kind === "folder" ? drag.ids[0] ?? null : null;

  const activeFolder =
    active.kind === "folder"
      ? folders.find((folder) => folder.id === active.id) ?? null
      : null;

  const rows = flattenFolderTree(tree, expanded);

  const commit = () => {
    const name = draft.trim();
    if (name && mode.kind === "creating") {
      onCreate(name, activeFolder?.id ?? null);
    } else if (name && mode.kind === "renaming") {
      onRename(mode.id, name);
    }
    setDraft("");
    setMode(IDLE);
  };

  const editor = (key: string, label: string) => (
    <input
      key={key}
      className="lw-home__folder-input"
      value={draft}
      autoFocus
      aria-label={label}
      placeholder="Folder name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          setDraft("");
          setMode(IDLE);
        }
      }}
    />
  );

  const confirming = mode.kind === "confirming" ? mode.id : null;
  const doomed = confirming
    ? folders.find((folder) => folder.id === confirming) ?? null
    : null;

  /**
   * "All boards" — the only row in this column that is not a folder.
   *
   * Takes no drop. There is no such thing as filing a board into everything,
   * and a target that accepted the drag and then did nothing would read as the
   * move having failed.
   */
  const allRow = () => {
    const on = !isTrashActive && isSameFolder(active, ALL_FOLDERS);
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        className={`lw-folder-row${on ? " lw-folder-row--on" : ""}`}
        // Named explicitly rather than left to the concatenated content, which
        // would announce "All boards 3" — and, next to a caret and a colour
        // dot, would differ from the folder rows for no reason a reader could
        // work out.
        aria-label={`All boards, ${plural(allCount, "board")}`}
        onClick={() => onSelect(ALL_FOLDERS)}
      >
        <span className="lw-folder-row__caret" aria-hidden="true" />
        <span
          className="lw-folder-row__dot"
          style={{ background: "var(--lw-accent)" }}
          aria-hidden="true"
        />
        <span className="lw-folder-row__name">All boards</span>
        <span className="lw-folder-row__count">{allCount}</span>
      </button>
    );
  };

  return (
    <div className="lw-home__sidebar">
      {/*
        No standing hint. "drag boards here" was permanent chrome telling
        everyone, on every visit, something they need to be told at most once —
        and the rows light up under the pointer anyway, which is the affordance
        that actually arrives at the moment it is useful.
      */}
      <div className="lw-home__sidebar-head">
        <span className="lw-home__sidebar-label">Folders</span>
      </div>

      <div
        className="lw-home__folders"
        role="radiogroup"
        aria-label="Filter by folder"
      >
        {allRow()}

        {rows.map(({ folder, depth, hasChildren }) => {
          if (mode.kind === "renaming" && mode.id === folder.id) {
            return editor(folder.id, `Rename ${folder.name}`);
          }

          const on =
            !isTrashActive && isSameFolder(active, inFolder(folder.id));
          const open = expanded.has(folder.id);

          return (
            <div
              key={folder.id}
              className={`lw-folder-row${on ? " lw-folder-row--on" : ""}${
                drag.isOver(folder.id) ? " lw-folder-row--over" : ""
              }${heldFolder === folder.id ? " lw-folder-row--held" : ""}`}
              style={{ paddingInlineStart: `${11 + depth * 15}px` }}
              {...drag.folderProps(folder.id)}
              // Both kinds, always. Whether *this* folder may take *that*
              // folder depends on the cycle rule, which needs to know what is
              // in the air — so it is answered by the route's `canDrop` at
              // hit-test time rather than baked into an attribute rendered
              // before the drag existed.
              {...drag.targetProps(folder.id, BOARD_OR_FOLDER)}
            >
              <button
                type="button"
                className="lw-folder-row__caret"
                aria-label={
                  hasChildren
                    ? `${open ? "Collapse" : "Expand"} ${folder.name}`
                    : undefined
                }
                aria-hidden={hasChildren ? undefined : true}
                tabIndex={hasChildren ? undefined : -1}
                disabled={!hasChildren}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExpanded(folder.id);
                }}
              >
                {hasChildren ? (open ? "▾" : "▸") : ""}
              </button>
              <span
                className="lw-folder-row__dot"
                style={{ background: folderColor(folder.colorIndex) }}
                aria-hidden="true"
              />
              <button
                type="button"
                role="radio"
                aria-checked={on}
                className="lw-folder-row__name lw-folder-row__select"
                aria-label={`${folder.name}, ${plural(
                  counts.get(folder.id) ?? 0,
                  "board",
                )}`}
                onClick={() => onSelect(inFolder(folder.id))}
              >
                {folder.name}
              </button>
              <span className="lw-folder-row__count">
                {counts.get(folder.id) ?? 0}
              </span>
            </div>
          );
        })}

        {/* Dropping onto the column's empty tail is the way to un-nest a
            folder, since there is no other gesture for "make this a root".
            Only ever accepts a folder: a board dropped here would have no
            obvious meaning, and guessing at one is how a gesture becomes a
            thing people avoid using. */}
        <div
          className={`lw-home__folder-root-drop${
            heldFolder !== null ? " lw-home__folder-root-drop--armed" : ""
          }${
            heldFolder !== null && drag.isOver(null)
              ? " lw-home__folder-root-drop--over"
              : ""
          }`}
          {...drag.targetProps(null, FOLDER_ONLY)}
        >
          {heldFolder !== null ? "drop here to move to the top level" : null}
        </div>

        {mode.kind === "creating" ? (
          editor("new", "Name the new folder")
        ) : (
          <button
            type="button"
            className="lw-home__folder-add"
            onClick={() => {
              setDraft("");
              setMode({ kind: "creating" });
            }}
          >
            <span aria-hidden="true">+</span> New folder
            {activeFolder ? ` in ${activeFolder.name}` : ""}
          </button>
        )}
      </div>

      {/*
        Trash, and deliberately OUTSIDE the radiogroup above.
        `role="radiogroup"` is labelled "Filter by folder", and a screen reader
        walking it would announce the trash as a fourth folder — which it is
        not: picking it replaces the grid rather than narrowing it. A separate
        button with `aria-pressed` says the true thing, that this is a mode
        rather than a filter.

        Takes no drop. Dragging a board onto it would be a second, silent way
        to delete one, with no confirm step and no undo prompt — the same
        gesture as filing, with a consequence nothing else in this column has.
      */}
      <div className="lw-home__trash-card">
        <button
          type="button"
          aria-pressed={isTrashActive}
          className={`lw-folder-row lw-home__trash-row${
            isTrashActive ? " lw-folder-row--on" : ""
          }`}
          onClick={onSelectTrash}
        >
          <span className="lw-folder-row__caret" aria-hidden="true" />
          <span className="lw-home__trash-icon" aria-hidden="true">
            {/* 16px, matching the dot it replaces. Inline rather than from
              `icons.tsx`, which lives in `packages/` — this column is Lawha's
              and must not add a reason to edit upstream (invariant 10). */}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="lw-folder-row__name">Trash</span>
        </button>
      </div>

      {/*
        Rename, recolour and Delete act on the folder currently being *shown*,
        so there is never a question of which one they mean — the grid beside
        them is already filtered to it.
      */}
      {activeFolder && mode.kind === "idle" ? (
        <div className="lw-home__folder-tools">
          <div
            className="lw-home__swatches"
            role="radiogroup"
            aria-label={`Colour for ${activeFolder.name}`}
          >
            <button
              type="button"
              role="radio"
              aria-checked={activeFolder.colorIndex === null}
              aria-label="No colour"
              className={`lw-home__swatch lw-home__swatch--none${
                activeFolder.colorIndex === null ? " lw-home__swatch--on" : ""
              }`}
              onClick={() => onRecolour(activeFolder.id, null)}
            />
            {COLLABORATOR_PALETTE.map((entry, index) => (
              <button
                key={entry.name}
                type="button"
                role="radio"
                aria-checked={activeFolder.colorIndex === index}
                aria-label={entry.name}
                className={`lw-home__swatch${
                  activeFolder.colorIndex === index
                    ? " lw-home__swatch--on"
                    : ""
                }`}
                // `hex`, not `hexDark`: a swatch is DOM, and only the
                // interactive canvas is colour-filtered in dark mode.
                style={{ background: entry.hex }}
                onClick={() => onRecolour(activeFolder.id, index)}
              />
            ))}
          </div>
          <div className="lw-home__folder-actions">
            <button
              type="button"
              className="lw-btn"
              onClick={() => {
                setDraft(activeFolder.name);
                setMode({ kind: "renaming", id: activeFolder.id });
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="lw-btn lw-btn--danger"
              onClick={() =>
                setMode({ kind: "confirming", id: activeFolder.id })
              }
            >
              Delete folder
            </button>
          </div>
        </div>
      ) : null}

      {doomed ? (
        <div className="lw-home__folder-confirm" role="alertdialog">
          {/*
            Stated plainly, because "delete folder" reads as "delete what is in
            it" to almost everyone, and here it genuinely does not: the server
            moves the contents up a level and keeps every one of them.
          */}
          <span className="lw-home__folder-confirm-text">
            Delete “{doomed.name}”? Only the folder goes. Everything in it —{" "}
            {plural(counts.get(doomed.id) ?? 0, "board")} and any subfolders —
            moves up one level and stays in your dashboard.
          </span>
          <button
            type="button"
            className="lw-btn"
            autoFocus
            onClick={() => setMode(IDLE)}
          >
            Keep it
          </button>
          <button
            type="button"
            className="lw-btn lw-btn--danger"
            onClick={() => {
              onDelete(doomed.id);
              setMode(IDLE);
            }}
          >
            Delete folder
          </button>
        </div>
      ) : null}
    </div>
  );
};
