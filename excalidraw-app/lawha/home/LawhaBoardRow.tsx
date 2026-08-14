import { useState } from "react";

import { LawhaBoardActions } from "./LawhaBoardActions";
import { LawhaBoardTags } from "./LawhaBoardTags";
import { LawhaRenameInput } from "./LawhaRenameInput";
import { describeAge, describeShapes } from "./boardText";

import type { BoardCardProps } from "./LawhaBoardCard";

/**
 * One board in the Details view.
 *
 * The same board as the card, in one line: pick, name, folder, tags, shapes,
 * modified. It exists because a grid of previews is the wrong tool once there
 * are more boards than fit on a screen — you stop recognising drawings and
 * start reading names — and because "Most shapes" and "Last edited" are only
 * really comparable in a column.
 *
 * Not a `<button>`, deliberately: the tag control and the action row are
 * buttons, and nesting them inside one would be invalid markup with a click
 * that lands on both. The name is the click target instead, and the row's own
 * `<div>` carries the drag.
 */
export const LawhaBoardRow = ({
  board,
  editing,
  thumbnail,
  path,
  isSelected,
  isSelecting,
  onToggleSelect,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onEditTags,
  drag,
}: BoardCardProps) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const held = drag.ids.includes(board.id);

  return (
    <div
      className={`lw-board-row${isSelected ? " lw-board-row--selected" : ""}${
        held ? " lw-board-row--held" : ""
      }`}
      {...drag.boardProps(board.id)}
    >
      <input
        type="checkbox"
        className="lw-board-row__pick"
        checked={isSelected}
        aria-label={`${isSelected ? "Deselect" : "Select"} ${board.name}`}
        onChange={(event) =>
          onToggleSelect((event.nativeEvent as MouseEvent).shiftKey === true)
        }
      />

      <span className="lw-board-row__title">
        {isRenaming ? (
          <LawhaRenameInput
            name={board.name}
            label={`Rename ${board.name}`}
            className="lw-board-row__rename"
            onCommit={onRename}
            onCancel={() => setIsRenaming(false)}
          />
        ) : (
          <button
            type="button"
            className="lw-board-row__name"
            // Same rule as the card: while a selection exists, a click picks
            // up rather than opens. Stated in the label so the two meanings are
            // never guessed at.
            onClick={(event) =>
              isSelecting ? onToggleSelect(event.shiftKey) : onOpen()
            }
            aria-label={
              isSelecting
                ? `${isSelected ? "Deselect" : "Select"} ${board.name}`
                : `Open ${board.name}`
            }
          >
            {board.name}
          </button>
        )}
        {editing > 0 ? (
          <span className="lw-board-row__live" title={`${editing} editing`}>
            <span className="lw-dot lw-dot--pulse" aria-hidden="true" />
            {editing}
          </span>
        ) : null}
      </span>

      <span className="lw-board-row__folder" title={path ?? undefined}>
        {path ?? "—"}
      </span>

      <LawhaBoardTags board={board} onEdit={onEditTags} compact />

      <span className="lw-board-row__shapes">{describeShapes(thumbnail)}</span>

      <span className="lw-board-row__age">{describeAge(board.updatedAt)}</span>

      <LawhaBoardActions
        isSelecting={isSelecting}
        onOpen={onOpen}
        onStartRename={() => setIsRenaming(true)}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        compact
      />
    </div>
  );
};
