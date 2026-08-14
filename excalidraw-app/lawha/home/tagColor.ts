import { COLLABORATOR_PALETTE } from "@excalidraw/common";

/**
 * The colour a tag chip paints itself with.
 *
 * `COLLABORATOR_PALETTE`, exactly as `folderColor` does and for the same
 * reasons: those twelve entries were chosen so a filled chip clears WCAG AA in
 * *both* themes, and a second palette would be a second thing to re-verify —
 * as well as putting two different blues on one dashboard, one on a folder and
 * one on a tag. Importing it adds no `packages/` divergence, because
 * `common/src/colors.ts` is already one of the diverged files (invariant 10).
 *
 * `hex` and never `hexDark`: a tag chip is DOM, and only the interactive canvas
 * is colour-filtered in dark mode.
 */
export const TAG_COLOR_COUNT = COLLABORATOR_PALETTE.length;

/** What an unset — or unrecognised — colour paints as. */
export const NO_TAG_COLOR = "var(--lw-muted3)";

export const tagColor = (colorIndex: number | null): string => {
  if (colorIndex === null) {
    return NO_TAG_COLOR;
  }
  // Total, with no `!`, for the reason `folderColor` records: the server bounds
  // the index to 0-255 rather than to this palette's length, precisely so a
  // thirteenth colour can ship without a migration. An index this build has
  // never heard of is therefore an expected input, not a bug — and a negative
  // one would make `%` return a negative and index nothing.
  const entry = COLLABORATOR_PALETTE[colorIndex % COLLABORATOR_PALETTE.length];
  return entry ? entry.hex : NO_TAG_COLOR;
};

/** The palette entry's name, for a control that must not be colour-only. */
export const tagColorName = (colorIndex: number | null): string =>
  colorIndex === null
    ? "No colour"
    : COLLABORATOR_PALETTE[colorIndex % COLLABORATOR_PALETTE.length]?.name ??
      "No colour";
