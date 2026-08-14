import { useState } from "react";

import { LawhaBoardActions } from "./LawhaBoardActions";
import { LawhaBoardTags } from "./LawhaBoardTags";
import { LawhaRenameInput } from "./LawhaRenameInput";
import { describeAge, describeShapes } from "./boardText";

import type { BoardThumbnail } from "./boardThumbnail";
import type { BoardDrag } from "./useBoardDrag";
import type { BoardListEntry } from "../../data/boards";

export interface BoardCardProps {
  board: BoardListEntry;
  /** How many people are on it right now; 0 when nobody is. */
  editing: number;
  /**
   * The rendered preview. `undefined` while it is still being built, `null`
   * once it is known there is nothing to draw.
   */
  thumbnail: BoardThumbnail | null | undefined;
  /** The folder path, shown under a search result. Null in a folder view. */
  path: string | null;
  isSelected: boolean;
  /**
   * True when *anything* in the grid is selected.
   *
   * The whole grid changes meaning then — a click picks a board up instead of
   * opening it — so the card has to say so out loud rather than let one click
   * quietly do two different things.
   */
  isSelecting: boolean;
  /** `extend` is a shift-click: take the run from the last board picked. */
  onToggleSelect: (extend: boolean) => void;
  onOpen: () => void;
  /** Called with the committed name; the card owns the editing state. */
  onRename: (name: string) => void;
  onDuplicate: () => void;
  /** Only called once the card's own confirm step has been accepted. */
  onDelete: () => void;
  onEditTags: () => void;
  drag: BoardDrag;
}

/**
 * One board in the Tiles view.
 *
 * The plate is the board's own scene, decrypted on this device and laid out as
 * bounding boxes — the server could never render it, because it holds
 * ciphertext and no key. The route owns that decrypt now rather than the card,
 * because the same number feeds the "Most shapes" sort and a sort cannot ask
 * each card what it happens to have finished loading.
 */
export const LawhaBoardCard = ({
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
    <article
      className={`lw-board-card${
        isSelecting ? " lw-board-card--selecting" : ""
      }${isSelected ? " lw-board-card--selected" : ""}${
        held ? " lw-board-card--held" : ""
      }`}
      {...drag.boardProps(board.id)}
    >
      {/*
      The pick control sits outside the preview button, not inside it: a
      checkbox nested in a button is invalid markup and the click would land on
      both. It is always rendered and merely *faded* rather than removed —
      something that only exists on hover cannot be reached with a keyboard and
      does not exist for a screen reader either. CSS shows it on hover, on
      focus, and unconditionally once a selection exists.

      `shiftKey` is read off the native event because a range selection has to
      work from the checkbox as well as from the card; React's change event for
      a checkbox wraps the click that produced it.
    */}
      <input
        type="checkbox"
        className="lw-board-card__pick"
        checked={isSelected}
        aria-label={`${isSelected ? "Deselect" : "Select"} ${board.name}`}
        onChange={(event) =>
          onToggleSelect((event.nativeEvent as MouseEvent).shiftKey === true)
        }
      />

      {/*
      The whole preview is the open affordance, but the action row below it is
      not inside it — nesting buttons is invalid, and a card-wide click target
      that swallows "Delete" is worse than a slightly smaller one.

      While a selection exists this same target selects instead. That is stated
      three ways rather than assumed: the label the button announces, the note
      drawn over the preview, and an explicit "Open" in the action row so the
      other meaning is never out of reach.
    */}
      <div className="lw-board-card__plate">
        <button
          type="button"
          className="lw-board-card__preview"
          onClick={(event) =>
            isSelecting ? onToggleSelect(event.shiftKey) : onOpen()
          }
          aria-label={
            isSelecting
              ? `${isSelected ? "Deselect" : "Select"} ${board.name}`
              : `Open ${board.name}`
          }
        >
          <span className="lw-board-card__grid" aria-hidden="true" />

          {isSelecting ? (
            <span className="lw-board-card__pick-note">
              {isSelected ? "click to deselect" : "click to select"}
            </span>
          ) : null}

          {thumbnail ? (
            <span className="lw-board-card__mini" aria-hidden="true">
              {thumbnail.shapes.map((shape, index) => (
                <span
                  key={index}
                  className={`lw-board-card__shape${
                    shape.hairline ? " lw-board-card__shape--line" : ""
                  }`}
                  style={{
                    left: `${shape.left}%`,
                    top: `${shape.top}%`,
                    width: `${shape.width}%`,
                    height: `${shape.height}%`,
                    borderColor: shape.stroke,
                    // Hairlines have no interior to fill.
                    background: shape.hairline ? undefined : shape.fill,
                    borderRadius: shape.rounded ? "50%" : undefined,
                  }}
                />
              ))}
            </span>
          ) : null}

          {editing > 0 ? (
            <span className="lw-board-card__live">
              <span className="lw-dot lw-dot--pulse" aria-hidden="true" />
              {editing} editing
            </span>
          ) : null}
        </button>
      </div>

      <div className="lw-board-card__body">
        <div className="lw-board-card__heading">
          {isRenaming ? (
            <LawhaRenameInput
              name={board.name}
              label={`Rename ${board.name}`}
              onCommit={onRename}
              onCancel={() => setIsRenaming(false)}
            />
          ) : (
            <h3 className="lw-board-card__name">{board.name}</h3>
          )}
        </div>

        <LawhaBoardTags board={board} onEdit={onEditTags} />

        <div className="lw-board-card__meta">
          {/*
            A search leaves the folder behind, so a result has to say where it
            came from — otherwise "found it" is followed by "…and where is it?"
            and one more click to find out.
          */}
          {path ? (
            <span className="lw-board-card__path" title={path}>
              {path}
            </span>
          ) : (
            <span>{describeShapes(thumbnail)}</span>
          )}
          <span>{describeAge(board.updatedAt)}</span>
        </div>

        <LawhaBoardActions
          isSelecting={isSelecting}
          onOpen={onOpen}
          onStartRename={() => setIsRenaming(true)}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
};
