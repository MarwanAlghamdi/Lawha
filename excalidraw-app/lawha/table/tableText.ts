/**
 * User-facing strings for the grid objects, in one place — the convention the
 * dashboard already follows in `home/homeText.ts` and `home/boardText.ts`.
 */
export const tableText = {
  insertTable: "Insert table",
  overlayLabel: "Table controls",
  moveTable: "Drag to move the whole table",
  selectColumn: (col: number) => `Select column ${col + 1}`,
  selectRow: (row: number) => `Select row ${row + 1}`,
  addRowAbove: "Add row above",
  addRowBelow: "Add row below",
  addColumnBefore: "Add column to the left",
  addColumnAfter: "Add column to the right",
  deleteRow: "Delete this row",
  deleteColumn: "Delete this column",
  deleteTable: "Delete table",
  toggleHeader: "Header row",
  fill: "Cell colour",
  clearFill: "No colour",
  lastRow: "A table keeps at least one row.",
  lastColumn: "A table keeps at least one column.",
} as const;

/**
 * Cell fills, as backgrounds rather than strokes.
 *
 * Deliberately the muted end of the palette: a cell fill sits behind text that
 * has to stay readable in both themes, and the interactive canvas is filtered in
 * dark mode (the reasoning behind invariant 16). Saturated fills survive that
 * filter badly.
 */
export const CELL_FILLS = [
  { label: "No colour", value: "transparent" },
  { label: "Grey", value: "#e9ecef" },
  { label: "Red", value: "#ffc9c9" },
  { label: "Yellow", value: "#ffec99" },
  { label: "Green", value: "#b2f2bb" },
  { label: "Blue", value: "#a5d8ff" },
  { label: "Violet", value: "#d0bfff" },
] as const;
