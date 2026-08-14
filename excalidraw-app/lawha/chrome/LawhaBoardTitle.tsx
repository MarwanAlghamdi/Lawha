import {
  useExcalidrawAPI,
  useExcalidrawStateValue,
} from "@excalidraw/excalidraw";
import { KEYS } from "@excalidraw/common";

import { useEffect, useRef, useState } from "react";

import { boardAccessAtom } from "../../collab/Collab";
import { renameBoard } from "../../data/boards";
import { getCurrentBoardId } from "../../data/currentBoard";

import { useAtomValue } from "../../app-jotai";

interface LawhaBoardTitleProps {
  /** Optional metadata chip, e.g. "architecture". */
  tag?: string | null;
}

/**
 * The board name, editable in place.
 *
 * Reads through `useExcalidrawStateValue("name")` and writes with
 * `updateScene`. Deliberately not `actionChangeProjectName`: actions are only
 * reachable via `actionManager`, which is internal, whereas `updateScene` is
 * the supported host path and produces the same state.
 *
 * `ProjectName` in the package is not reused either — it is a label+input pair
 * styled for the export dialog, with a hard-coded input id and no
 * click-to-edit affordance.
 *
 * `AppState.name` is browser-local only, so on commit the rename is also sent
 * to `PATCH /api/boards/:id` — best-effort, like every other call in
 * `data/boards.ts`, so a flaky network never blocks the local rename the user
 * already sees. Skipped entirely when there is no current board (the scratch
 * canvas at `/`), which has nothing to PATCH.
 *
 * **A viewer cannot rename, and the control says so rather than finding out.**
 * The server already refuses — `PATCH /api/boards/:id` throws `forbidden` for a
 * `name` change without `canEdit` — but the button offered the edit anyway, so
 * a view-only visitor could rename the board on their own screen, watch it
 * stick locally, and never learn that the 403 had thrown the change away. That
 * is invariant 24: the client must know what the server will refuse. It is also
 * invariant 21's shape — a permission enforced in one layer is not enforced,
 * and the layer that was missing here is the one the user actually touches.
 */
export const LawhaBoardTitle = ({ tag }: LawhaBoardTitleProps) => {
  const excalidrawAPI = useExcalidrawAPI();
  const name = useExcalidrawStateValue("name");
  // Defaults to full access, so the scratch canvas at `/` and every ordinary
  // owner are unaffected; only a board the server has told us is view-only
  // reaches the read-only branch below.
  const canEdit = useAtomValue(boardAccessAtom).canEdit;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against committing a half-composed CJK/IME sequence on Enter.
  const isComposingRef = useRef(false);

  const displayName = name?.trim() || "Untitled";

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    if (!canEdit) {
      return;
    }
    setDraft(displayName);
    setIsEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    if (next && next !== displayName) {
      excalidrawAPI?.updateScene({ appState: { name: next } });

      const boardId = getCurrentBoardId();
      if (boardId) {
        renameBoard(boardId, next).catch((error) => {
          console.warn("lawha: failed to persist board rename", error);
        });
      }
    }
    setIsEditing(false);
  };

  const cancel = () => setIsEditing(false);

  if (isEditing) {
    return (
      <div className="lw-topbar__title lw-topbar__title--editing">
        <input
          ref={inputRef}
          className="lw-input lw-topbar__title-input"
          value={draft}
          aria-label="Board name"
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === KEYS.ENTER && !isComposingRef.current) {
              event.preventDefault();
              commit();
            } else if (event.key === KEYS.ESCAPE) {
              event.preventDefault();
              cancel();
            }
            // The editor listens for keys globally; without this, typing a
            // board name would also trigger tool shortcuts.
            event.stopPropagation();
          }}
        />
      </div>
    );
  }

  // A span, not a disabled button. A disabled control still occupies the tab
  // order in some engines and reads as "temporarily unavailable"; this is not
  // temporary and there is nothing to wait for.
  if (!canEdit) {
    return (
      <div className="lw-topbar__title">
        <span
          className="lw-topbar__title-button lw-topbar__title-button--readonly"
          title="You have view-only access to this board"
          aria-label={`Board name: ${displayName}. You have view-only access.`}
        >
          {displayName}
        </span>
        {tag ? <span className="lw-chip lw-chip--purple">{tag}</span> : null}
      </div>
    );
  }

  return (
    <div className="lw-topbar__title">
      <button
        type="button"
        className="lw-topbar__title-button"
        onClick={startEditing}
        title="Rename board"
        aria-label={`Board name: ${displayName}. Activate to rename.`}
      >
        {displayName}
      </button>
      {tag ? <span className="lw-chip lw-chip--purple">{tag}</span> : null}
    </div>
  );
};
