import { tagColor } from "./tagColor";

import type { BoardListEntry, BoardTag } from "../../data/boards";

interface LawhaBoardTagsProps {
  board: BoardListEntry;
  onEdit: () => void;
  /** The Details row has one line to fit these on, so it truncates instead. */
  compact?: boolean;
}

/**
 * A board's tags, and the way to change them.
 *
 * The colour is stored as one CSS colour per tag, and the chip's background is
 * derived from it with `color-mix` rather than stored as a second value. One
 * stored colour then works in both themes: a light wash of the same hue is
 * legible on the light surface and on the dark one, whereas a fixed pale
 * background would be a bright rectangle in dark mode.
 *
 * `untagged` is rendered rather than nothing, because an empty slot gives the
 * "+" nothing to sit beside and makes an untagged board look like a card that
 * failed to finish loading.
 */
export const LawhaBoardTags = ({
  board,
  onEdit,
  compact,
}: LawhaBoardTagsProps) => {
  const chip = (tag: BoardTag) => (
    <span
      key={tag.id}
      className="lw-tag-chip"
      style={{ color: tagColor(tag.colorIndex) }}
    >
      {tag.name}
    </span>
  );

  return (
    <button
      type="button"
      className={`lw-tag-row${compact ? " lw-tag-row--compact" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      aria-label={
        board.tags.length
          ? `Edit tags on ${board.name}: ${board.tags
              .map((tag) => tag.name)
              .join(", ")}`
          : `Add a tag to ${board.name}`
      }
    >
      {board.tags.length ? (
        board.tags.map(chip)
      ) : (
        <span className="lw-tag-chip lw-tag-chip--none">untagged</span>
      )}
      <span className="lw-tag-chip lw-tag-chip--add" aria-hidden="true">
        +
      </span>
    </button>
  );
};
