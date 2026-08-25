import { useState } from "react";

import { NO_FOLDER } from "./boardFilters";
import { plural } from "./homeText";

export interface FolderOption {
  id: string;
  /** "Platform / Sync engine" — the whole path, because leaf names repeat. */
  label: string;
}

interface LawhaSelectionBarProps {
  count: number;
  folderOptions: FolderOption[];
  /** True while a transfer is running; every action that writes locks with it. */
  busy: boolean;
  onExport: () => void;
  /** `null` files the selection out of every folder. */
  onMove: (folderId: string | null) => void;
  onMoveToNewFolder: (name: string) => void;
  /** Only called once the bar's own confirm step has been accepted. */
  onDelete: () => void;
  onClear: () => void;
}

/** Idle, naming a new folder, or confirming a bulk delete. */
type BarMode = "idle" | "naming" | "confirming";

const NEW_FOLDER = "__new";

/**
 * What you can do with the boards you have picked.
 *
 * It floats, fixed at the bottom of the viewport, and that is a reversal: this
 * bar used to sit in the page between the filters and the grid, with a comment
 * arguing that a floating bar covers the very cards you are checking your
 * selection against. The design chose otherwise and the design wins here, for a
 * reason the old comment did not weigh — a selection is often made by scrolling
 * through a long grid, and an in-flow bar scrolls away with the filters, so by
 * the time you have picked the last board the controls are off screen. It sits
 * at the bottom centre and covers one row's worth of grid, and the grid gets
 * bottom padding to keep the last row clear of it. ADR 0007 records the change.
 *
 * The note about what a click means is not decoration. While anything is
 * selected, clicking a card picks it up instead of opening it, and a click that
 * means two different things depending on state nobody can see is a trap.
 *
 * Delete asks first, the way the card does, because a bulk delete is the one
 * action on this page with nothing behind it. The design has no confirm step;
 * this keeps one.
 */
export const LawhaSelectionBar = ({
  count,
  folderOptions,
  busy,
  onExport,
  onMove,
  onMoveToNewFolder,
  onDelete,
  onClear,
}: LawhaSelectionBarProps) => {
  const [mode, setMode] = useState<BarMode>("idle");
  const [draft, setDraft] = useState("");

  const commitNewFolder = () => {
    const name = draft.trim();
    if (name) {
      onMoveToNewFolder(name);
    }
    setDraft("");
    setMode("idle");
  };

  return (
    <div
      className="lw-selection-bar"
      role="region"
      aria-label="Selected boards"
    >
      <div className="lw-selection-bar__row">
        <span className="lw-selection-bar__count" aria-live="polite">
          {plural(count, "board")} selected
        </span>

        <span className="lw-selection-bar__divider" aria-hidden="true" />

        <select
          className="lw-selection-bar__select"
          aria-label="Move the selection to a folder"
          // Always reset to the placeholder: this is an action, not a setting,
          // and leaving the last folder showing would suggest the selection
          // still lives there.
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              return;
            }
            if (value === NEW_FOLDER) {
              setDraft("");
              setMode("naming");
              return;
            }
            onMove(value === NO_FOLDER ? null : value);
          }}
        >
          <option value="">Move to folder…</option>
          {/*
            The only way back out of a folder, now that the "Unfiled" row and
            its drop target are gone. Named for what it does to the board in
            your hand rather than for the pile it used to join — and kept
            deliberately, because deleting it along with the word would have
            made filing a one-way door: no target to drop on, no entry to pick,
            and a board that can go in but never come out.
          */}
          <option value={NO_FOLDER}>Remove from folder</option>
          {folderOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value={NEW_FOLDER}>+ New folder…</option>
        </select>

        <button
          type="button"
          className="lw-selection-bar__primary"
          onClick={onExport}
          disabled={busy}
          title="Save the selected boards this browser can decrypt to one file"
        >
          {busy ? "Working…" : "Export selected"}
        </button>
        <button
          type="button"
          className="lw-selection-bar__danger"
          onClick={() => setMode("confirming")}
          disabled={busy}
        >
          Delete
        </button>
        <button
          type="button"
          className="lw-selection-bar__quiet"
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      <p className="lw-selection-bar__note">
        Clicking a board picks it up instead of opening it while this bar is
        here. Use a card’s “Open” button, or Clear to go back.
      </p>

      {/*
        Creating a folder and filing the selection into it is one step, because
        it is one intention: nobody opens this row wanting an empty folder.
      */}
      {mode === "naming" ? (
        <div className="lw-selection-bar__row lw-selection-bar__second">
          <span className="lw-selection-bar__label">New folder</span>
          <input
            className="lw-selection-bar__input"
            value={draft}
            autoFocus
            aria-label={`Name a new folder for the ${plural(
              count,
              "selected board",
            )}`}
            placeholder="Folder name"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitNewFolder();
              } else if (event.key === "Escape") {
                setDraft("");
                setMode("idle");
              }
            }}
          />
          <button
            type="button"
            className="lw-selection-bar__primary"
            onClick={commitNewFolder}
          >
            Create and move
          </button>
          <button
            type="button"
            className="lw-selection-bar__quiet"
            onClick={() => {
              setDraft("");
              setMode("idle");
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {mode === "confirming" ? (
        <div
          className="lw-selection-bar__row lw-selection-bar__second"
          role="alertdialog"
        >
          <span className="lw-selection-bar__label">
            {/* Matches the single-board wording, and for the reason given
                there: the trash makes "cannot be undone" false here and true
                only on the trash's own delete (ADR 0029). */}
            Move {plural(count, "board")} to the trash? You can restore them
            from there.
          </span>
          <button
            type="button"
            className="lw-selection-bar__quiet"
            autoFocus
            onClick={() => setMode("idle")}
          >
            Keep them
          </button>
          <button
            type="button"
            className="lw-selection-bar__danger"
            onClick={() => {
              onDelete();
              setMode("idle");
            }}
          >
            Delete {count}
          </button>
        </div>
      ) : null}
    </div>
  );
};
