import { useState } from "react";

import { COLLABORATOR_PALETTE } from "@excalidraw/common";

import { LawhaModal } from "./LawhaModal";

import { tagColor } from "./tagColor";

import type { BoardListEntry, TagSummary } from "../../data/boards";

interface LawhaTagModalProps {
  /**
   * The board being labelled, or null for "manage my tags".
   *
   * Nullable so the same modal serves both errands. Without a board there is
   * nothing to toggle a tag *onto*, so the picker is hidden and the manage
   * pane — rename, recolour, delete — is the whole dialog. Two components
   * would be two places for the delete confirmation to drift.
   */
  board: BoardListEntry | null;
  tags: TagSummary[];
  busy: boolean;
  onClose: () => void;
  /** Toggles one tag on this board. The route owns the write and the reload. */
  onToggle: (tagId: string) => void;
  /** Creates a tag and puts it straight on this board — one intention, one step. */
  onCreate: (name: string) => void;
  /** Renames a tag everywhere it is used. */
  onRename: (tagId: string, name: string) => void;
  /** Sets or clears a tag's colour. Null means "no colour", not index 0. */
  onRecolour: (tagId: string, colorIndex: number | null) => void;
  /** Deletes a tag from the account, unlabelling every board carrying it. */
  onDelete: (tagId: string) => void;
}

/**
 * The tags on one board.
 *
 * Reached from the chips on the card, which is where you notice a tag is wrong.
 * It is per board rather than a bulk action because tags are how a single board
 * is described, and the selection bar already owns the bulk verbs.
 *
 * Creating a tag files it onto this board immediately. A "New tag" that made an
 * unattached tag would leave the user in the modal wondering why nothing about
 * their board had changed.
 *
 * **Managing tags lives here too, behind a toggle.** There was previously no
 * way to rename or delete a tag at all: a typo was permanent and an obsolete
 * tag stayed in the picker forever, which is how a tag list stops being worth
 * reading. It is behind a toggle rather than always on because the common
 * errand is "put a tag on this board", and rows that also delete things are the
 * wrong default for that.
 *
 * Renaming rather than delete-and-recreate is the reason the API has a PATCH:
 * a tag is one row referenced by `board_tags`, so a rename relabels every board
 * carrying it, while recreating would silently unlabel all of them.
 */
export const LawhaTagModal = ({
  board,
  tags,
  busy,
  onClose,
  onToggle,
  onCreate,
  onRename,
  onRecolour,
  onDelete,
}: LawhaTagModalProps) => {
  const [draft, setDraft] = useState("");
  const [isManaging, setIsManaging] = useState(false);
  /** Which tag is being renamed, and to what. */
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  /**
   * Which tag has been asked to be deleted, awaiting confirmation.
   *
   * Two clicks, in the row, rather than a `window.confirm` (invariant 19) or a
   * second modal over this one. Deleting a tag unlabels every board carrying
   * it, which is not undoable and is not obvious from a row that says nothing
   * about how many boards that is.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const on = new Set(board?.tags.map((tag) => tag.id) ?? []);
  // Without a board there is nothing to put a tag on, so the manage pane is
  // not a mode to switch into — it is the dialog.
  const managing = isManaging || !board;

  const create = () => {
    const name = draft.trim();
    if (!name) {
      return;
    }
    onCreate(name);
    setDraft("");
  };

  return (
    <LawhaModal
      title="Tags"
      description={
        board
          ? `On “${board.name}”. Tags belong to your account, so a board shared with someone else keeps their tags separate from yours.`
          : "Tags belong to your account. A board shared with someone else keeps their tags separate from yours, so renaming or recolouring one here changes it only for you."
      }
      onClose={onClose}
    >
      {/* Nothing to toggle a tag onto without a board. */}
      {board ? (
        <div
          className="lw-tag-picker"
          role="group"
          aria-label={`Tags on ${board?.name ?? ""}`}
        >
          {tags.length === 0 ? (
            <p className="lw-field__hint">
              No tags yet. Type one below and it goes straight onto this board.
            </p>
          ) : (
            tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-pressed={on.has(tag.id)}
                className={`lw-tag-option${
                  on.has(tag.id) ? " lw-tag-option--on" : ""
                }`}
                style={{ color: tagColor(tag.colorIndex) }}
                disabled={busy}
                onClick={() => onToggle(tag.id)}
              >
                {on.has(tag.id) ? "✓ " : ""}
                {tag.name}
              </button>
            ))
          )}
        </div>
      ) : null}

      {managing ? (
        <div className="lw-tag-manage" role="group" aria-label="Manage tags">
          {tags.map((tag) => (
            <div key={tag.id} className="lw-tag-manage__row">
              {editing?.id === tag.id ? (
                <>
                  <input
                    className="lw-field__input"
                    value={editing.name}
                    aria-label={`Rename ${tag.name}`}
                    autoFocus
                    onChange={(event) =>
                      setEditing({ id: tag.id, name: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const next = editing.name.trim();
                        if (next && next !== tag.name) {
                          onRename(tag.id, next);
                        }
                        setEditing(null);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="lw-btn"
                    disabled={busy}
                    onClick={() => {
                      const next = editing.name.trim();
                      if (next && next !== tag.name) {
                        onRename(tag.id, next);
                      }
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="lw-tag-manage__name"
                    style={{ color: tagColor(tag.colorIndex) }}
                  >
                    {tag.name}
                  </span>
                  {/*
                    Swatches over `COLLABORATOR_PALETTE`, not a free colour
                    input. Those twelve clear WCAG AA in both themes and each
                    carries a dark-mode pre-image; a hex picked against one
                    theme is wrong in the other, and the wire format is an
                    index precisely so it cannot try (invariant 16).

                    "No colour" comes first and is a real option, because
                    "uncoloured" and "blue" have to stay tellable apart —
                    index 0 as a default would erase that distinction.
                  */}
                  <span
                    className="lw-tag-manage__swatches"
                    role="radiogroup"
                    aria-label={`Colour for ${tag.name}`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={tag.colorIndex === null}
                      aria-label="No colour"
                      title="No colour"
                      className={`lw-tag-swatch lw-tag-swatch--none${
                        tag.colorIndex === null ? " lw-tag-swatch--on" : ""
                      }`}
                      disabled={busy}
                      onClick={() => onRecolour(tag.id, null)}
                    />
                    {COLLABORATOR_PALETTE.map((entry, index) => (
                      <button
                        key={entry.name}
                        type="button"
                        role="radio"
                        aria-checked={tag.colorIndex === index}
                        // Named, so the control is not colour-only — on the
                        // one control whose whole job is assigning a colour.
                        aria-label={entry.name}
                        title={entry.name}
                        className={`lw-tag-swatch${
                          tag.colorIndex === index ? " lw-tag-swatch--on" : ""
                        }`}
                        style={{ background: entry.hex }}
                        disabled={busy}
                        onClick={() => onRecolour(tag.id, index)}
                      />
                    ))}
                  </span>
                  <span className="lw-tag-manage__actions">
                    <button
                      type="button"
                      className="lw-btn"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        setEditing({ id: tag.id, name: tag.name });
                      }}
                    >
                      Rename
                    </button>
                    {confirming === tag.id ? (
                      <button
                        type="button"
                        className="lw-btn lw-btn--danger"
                        disabled={busy}
                        onClick={() => {
                          onDelete(tag.id);
                          setConfirming(null);
                        }}
                      >
                        Delete from every board?
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="lw-btn"
                        disabled={busy}
                        onClick={() => setConfirming(tag.id)}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {/*
        Hidden without a board: there is no picker to go back to, so a toggle
        reading "Done managing" would offer to leave the only thing on screen.
      */}
      {board && tags.length > 0 ? (
        <button
          type="button"
          className="lw-auth-card__link"
          onClick={() => {
            setIsManaging((current) => !current);
            setEditing(null);
            setConfirming(null);
          }}
        >
          {isManaging ? "Done managing" : "Rename, recolour or delete tags"}
        </button>
      ) : null}

      <div className="lw-tag-picker__new">
        <input
          className="lw-field__input"
          value={draft}
          aria-label="New tag name"
          placeholder="New tag…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
        />
        <button
          type="button"
          className="lw-btn lw-btn--primary"
          disabled={busy || !draft.trim()}
          onClick={create}
        >
          Add
        </button>
      </div>

      <div className="lw-modal__actions">
        <button type="button" className="lw-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </LawhaModal>
  );
};
