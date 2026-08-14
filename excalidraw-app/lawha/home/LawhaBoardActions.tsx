import { useState } from "react";

interface LawhaBoardActionsProps {
  /** True when anything in the grid is selected; the preview then selects. */
  isSelecting: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** The Details row has one line, so it drops Duplicate. */
  compact?: boolean;
}

/**
 * Open, Rename, Duplicate, Delete — and the confirm step in front of Delete.
 *
 * One component for the card and the Details row, because the confirm is the
 * part that must not vary: a bulk delete is the only action on this page with
 * nothing behind it, and two implementations is one of them eventually losing
 * the "are you sure".
 *
 * Always in the DOM, never conditionally rendered on hover. CSS fades it in on
 * hover and on `:focus-within`; the reason is the one the pick checkbox already
 * carries — something that only exists on hover cannot be reached with a
 * keyboard and does not exist for a screen reader either.
 */
export const LawhaBoardActions = ({
  isSelecting,
  onOpen,
  onStartRename,
  onDuplicate,
  onDelete,
  compact,
}: LawhaBoardActionsProps) => {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="lw-board-card__confirm" role="alertdialog">
        <span className="lw-board-card__confirm-text">
          Delete this board? Everything on it goes too, and it cannot be undone.
        </span>
        <div className="lw-board-card__actions">
          <button
            type="button"
            className="lw-btn"
            autoFocus
            onClick={() => setConfirming(false)}
          >
            Keep it
          </button>
          <div className="lw-board-card__gap" />
          <button
            type="button"
            className="lw-btn lw-btn--danger"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lw-board-card__actions">
      {/*
        "Open" appears while selecting, and in the Details row always. In the
        grid the preview is normally the way in, so a second Open would be
        noise — but once a selection exists the preview selects instead, and
        without this the only way to open a board would be to abandon the
        selection first.
      */}
      {isSelecting || compact ? (
        <button type="button" className="lw-btn" onClick={onOpen}>
          Open
        </button>
      ) : null}
      {/*
        Rename and Delete are deliberately NOT gated on `isOpenable`. The name
        is a server-side column and the row is yours; being unable to tidy up a
        board you cannot read would be a worse product than one that lets you.
      */}
      <button type="button" className="lw-btn" onClick={onStartRename}>
        Rename
      </button>
      {compact ? null : (
        <>
          <button
            type="button"
            className="lw-btn"
            onClick={onDuplicate}
            // Duplicate used to be gated on holding the board's key: the
            // server copies the stored scene verbatim, so a copy was readable
            // only under the *source's* key, and duplicating a board you could
            // not open quietly produced a second board nobody could ever open.
            // This deployment has one — "Do not touch copy" — sitting next to
            // the board it came from. A stored scene is plaintext now, so a
            // copy is as readable as its source and there is nothing to gate.
          >
            Duplicate
          </button>
        </>
      )}
      <div className="lw-board-card__gap" />
      <button
        type="button"
        className="lw-btn lw-btn--danger"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    </div>
  );
};
