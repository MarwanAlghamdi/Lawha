/**
 * Numeric grids — a matrix is a table whose cells carry a parsed value.
 *
 * Everything here builds on `../table`: same composed rectangles, same
 * `customData` tag, same reasons (ADR 0023). The only additions are a numeric
 * reading of the cell text and the operations that reading makes possible.
 */
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { buildTable, tableIdOf } from "../table/tableBuild";
import {
  LAWHA_KEY,
  cellKey,
  cellText,
  readCellTag,
  readTable,
} from "../table/tableModel";

export interface MatrixSpec {
  x: number;
  y: number;
  rows: number;
  cols: number;
  values?: number[][];
  colWidth?: number;
  rowHeight?: number;
}

/** Matrix cells are square-ish and narrower than table cells — they hold numbers. */
export const MATRIX_CELL = 56;

export const zeros = (rows: number, cols: number): number[][] =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

export const ones = (rows: number, cols: number): number[][] =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));

export const identity = (n: number): number[][] =>
  Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => (row === col ? 1 : 0)),
  );

export const buildMatrix = (spec: MatrixSpec): ExcalidrawElement[] => {
  const {
    x,
    y,
    rows,
    cols,
    values,
    colWidth = MATRIX_CELL,
    rowHeight = MATRIX_CELL,
  } = spec;
  return buildTable({
    x,
    y,
    rows,
    cols,
    colWidth,
    rowHeight,
    // No header row: a matrix has no column names, and shading row 0 would
    // misrepresent an ordinary row of data as a label.
    header: false,
    kind: "matrix-cell",
    data: values ?? zeros(rows, cols),
  });
};

export { tableIdOf as matrixIdOf };

/**
 * Read the grid back as numbers.
 *
 * The text is the source of truth rather than the cached `value` on the tag: a
 * user edits a cell by typing into it, which changes the bound text element and
 * knows nothing about our `customData`. Anything unparseable reads as `NaN`, and
 * every consumer here treats `NaN` as "no value" rather than zero — a blank cell
 * and a zero are different claims about the data.
 */
export const readMatrix = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): number[][] | null => {
  const model = readTable(elements, tableId);
  if (!model) {
    return null;
  }
  return Array.from({ length: model.rows }, (_, row) =>
    Array.from({ length: model.cols }, (_, col) => {
      const text = cellText(model.cells.get(cellKey(row, col)));
      return text === "" ? NaN : Number(text);
    }),
  );
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const hexToRgb = (hex: string) => {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

const toHex = (channel: number) =>
  Math.round(clamp01(channel / 255) * 255)
    .toString(16)
    .padStart(2, "0");

/** Linear ramp between two hex colours. */
export const mixHex = (from: string, to: string, t: number): string => {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = clamp01(t);
  return `#${a
    .map((channel, i) => toHex(channel + (b[i] - channel) * k))
    .join("")}`;
};

export const HEATMAP_LOW = "#ffffff";
export const HEATMAP_HIGH = "#4c6ef5";

/**
 * Shade every cell by its value, scaled across the grid's own range.
 *
 * Scaled to the data rather than to a fixed domain, because a matrix of
 * probabilities and a matrix of logits have nothing in common except that the
 * reader wants to see which entries are large. A grid whose values are all equal
 * gets a single flat shade rather than a division by zero.
 */
export const applyHeatmap = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  low: string = HEATMAP_LOW,
  high: string = HEATMAP_HIGH,
): ExcalidrawElement[] => {
  const values = readMatrix(elements, tableId);
  if (!values) {
    return [...elements];
  }
  const finite = values.flat().filter((n) => Number.isFinite(n));
  if (finite.length === 0) {
    return [...elements];
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;

  return elements.map((element) => {
    const tag = readCellTag(element);
    if (!tag || tag.tableId !== tableId) {
      return element;
    }
    const value = values[tag.row]?.[tag.col];
    if (!Number.isFinite(value)) {
      return element;
    }
    const t = span === 0 ? 0.5 : (value - min) / span;
    return newElementWith(element, {
      backgroundColor: mixHex(low, high, t),
      fillStyle: "solid",
      // Cache the parsed value so a later read does not have to re-parse text
      // that has not changed. The text stays authoritative; this is a hint.
      customData: { ...element.customData, [LAWHA_KEY]: { ...tag, value } },
    });
  });
};

/** Undo the shading, leaving the numbers alone. */
export const clearHeatmap = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): ExcalidrawElement[] =>
  elements.map((element) => {
    const tag = readCellTag(element);
    if (!tag || tag.tableId !== tableId) {
      return element;
    }
    return newElementWith(element, { backgroundColor: "transparent" });
  });

/**
 * Transpose in place, as a fresh grid at the same origin.
 *
 * This one *does* mint new ids, because every cell changes both its coordinates
 * and its position — there is no correspondence worth preserving, and pretending
 * otherwise would mean a rename of every tag plus a move of every rectangle. The
 * old cells are marked deleted rather than dropped, so a peer cannot reinstate
 * them (`reconcileElements` unions and never deletes).
 */
export const transposeMatrix = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  const values = readMatrix(elements, tableId);
  if (!model || !values) {
    return [...elements];
  }

  const flipped = Array.from({ length: model.cols }, (_, row) =>
    Array.from({ length: model.rows }, (_, col) => values[col][row]),
  );

  const cellWidth =
    model.cells.get(cellKey(0, 0))?.element.width ?? MATRIX_CELL;
  const cellHeight =
    model.cells.get(cellKey(0, 0))?.element.height ?? MATRIX_CELL;

  const fresh = buildTable({
    x: model.bounds.x,
    y: model.bounds.y,
    rows: model.cols,
    cols: model.rows,
    colWidth: cellWidth,
    rowHeight: cellHeight,
    header: false,
    kind: "matrix-cell",
    tableId,
    data: flipped.map((row) => row.map((n) => (Number.isFinite(n) ? n : ""))),
  });

  const doomed = new Set<string>();
  for (const cell of model.cells.values()) {
    doomed.add(cell.element.id);
    if (cell.text) {
      doomed.add(cell.text.id);
    }
  }

  return [
    ...elements.map((element) =>
      doomed.has(element.id)
        ? newElementWith(element, { isDeleted: true })
        : element,
    ),
    ...fresh,
  ];
};
