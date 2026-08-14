import { useState } from "react";

interface LawhaRenameInputProps {
  /** The current name, which is where the draft starts. */
  name: string;
  label: string;
  className?: string;
  /** Called only with a non-empty name that actually changed. */
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Rename in place: the input replaces the name where it stands.
 *
 * Shared by the card and the Details row so the two cannot disagree about what
 * Escape does. It was `window.prompt` once, which this product is not allowed
 * to use (invariant 19) and which blocks the renderer besides.
 *
 * An empty draft commits nothing, so blurring an emptied field is a cancel
 * rather than a board called "".
 */
export const LawhaRenameInput = ({
  name,
  label,
  className,
  onCommit,
  onCancel,
}: LawhaRenameInputProps) => {
  const [draft, setDraft] = useState(name);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) {
      onCommit(next);
    }
    onCancel();
  };

  return (
    <input
      className={className ?? "lw-board-card__rename"}
      value={draft}
      autoFocus
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          onCancel();
        }
      }}
      // A rename input inside a draggable card: without this, a text selection
      // drag inside the field starts dragging the card instead and the caret
      // never moves.
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
    />
  );
};
