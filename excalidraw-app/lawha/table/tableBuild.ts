/**
 * Building a grid: spec -> element skeletons -> real elements.
 *
 * Construction goes through `convertToExcalidrawElements`, which is a public
 * export of the editor package (`packages/excalidraw/index.tsx:485`). Nothing
 * here reaches into `packages/`, and nothing here invents an element type — see
 * ADR 0023.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { randomId } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { LAWHA_KEY } from "./tableModel";

import type { CellTag, GridKind } from "./tableModel";

export const DEFAULT_COL_WIDTH = 140;
export const DEFAULT_ROW_HEIGHT = 44;

/**
 * A header cell is shaded, and the shade is a *background* rather than a bolder
 * stroke: the interactive canvas is filtered in dark mode, so anything that has
 * to stay legible in both themes is safer as a fill the theme already handles
 * than as a colour we pick (the same reasoning as invariant 16).
 */
export const HEADER_BACKGROUND = "#e9ecef";
export const CELL_BACKGROUND = "transparent";

export interface TableSpec {
  /** Scene coordinates of the grid's top-left corner. */
  x: number;
  y: number;
  rows: number;
  cols: number;
  colWidth?: number;
  rowHeight?: number;
  /** Treat row 0 as a header row. */
  header?: boolean;
  kind?: GridKind;
  /** Reuse an id when rebuilding an existing grid; omit to mint a new one. */
  tableId?: string;
  /** Optional initial text, `data[row][col]`. Missing entries become empty cells. */
  data?: (string | number | null | undefined)[][];
}

const cellCustomData = (tag: CellTag) => ({ [LAWHA_KEY]: tag });

/**
 * Build one grid.
 *
 * Every cell is a rectangle carrying its own `label`, which is what gives it a
 * bound text element. That is why each cell is its own container rather than one
 * table element with N labels: bound text is 1:1 — `getBoundTextElement` returns
 * *the first* bound text — so N labels on one container is not a thing the editor
 * can represent.
 *
 * **Cells are deliberately NOT grouped.** A group makes the editor treat the
 * table as one object, but it also puts an "enter the group" step in front of
 * every cell: a double-click selects the cell, and only a *second* double-click
 * starts typing in it. Measured, on a real board. For a thing whose entire
 * purpose is being filled in, four clicks per cell is the wrong trade.
 *
 * Cohesion comes from the overlay instead — it draws a move bar along the top
 * edge that drags the whole table, and it snaps a stray cell back to the
 * position its row and column imply. Every cell still knows where it belongs,
 * because that is what the tag is for.
 */
export const buildTable = (spec: TableSpec): ExcalidrawElement[] => {
  const {
    x,
    y,
    rows,
    cols,
    colWidth = DEFAULT_COL_WIDTH,
    rowHeight = DEFAULT_ROW_HEIGHT,
    header = true,
    kind = "table-cell",
    tableId = randomId(),
    data,
  } = spec;

  if (rows < 1 || cols < 1) {
    return [];
  }

  const skeletons = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const isHeader = header && row === 0;
      const raw = data?.[row]?.[col];
      const text = raw === null || raw === undefined ? "" : String(raw);
      const value = typeof raw === "number" ? raw : null;

      skeletons.push({
        type: "rectangle" as const,
        x: x + col * colWidth,
        y: y + row * rowHeight,
        width: colWidth,
        height: rowHeight,
        backgroundColor: isHeader ? HEADER_BACKGROUND : CELL_BACKGROUND,
        fillStyle: "solid" as const,
        strokeWidth: 1 as const,
        // Square corners. A grid of rounded rectangles reads as a set of cards
        // rather than a table, and the shared edges stop looking shared.
        roundness: null,
        customData: cellCustomData({
          kind,
          tableId,
          row,
          col,
          header: isHeader,
          value,
        }),
        // `label` is what binds a text element into the rectangle. Passing it
        // with an explicit width/height above matters: a label on a container
        // whose width is `undefined` auto-sizes the container to the text
        // (`transform.ts:539-548`), which would give every cell a different size.
        label: text
          ? {
              text,
              fontSize: 16,
              textAlign: "center" as const,
              verticalAlign: "middle" as const,
            }
          : undefined,
      });
    }
  }

  return convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  );
};

/** The `tableId` of a freshly built grid, for selecting it after insert. */
export const tableIdOf = (
  elements: readonly ExcalidrawElement[],
): string | null => {
  for (const element of elements) {
    const tag = element.customData?.[LAWHA_KEY] as CellTag | undefined;
    if (tag?.tableId) {
      return tag.tableId;
    }
  }
  return null;
};
