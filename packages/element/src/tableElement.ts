import {
  FONT_FAMILY,
  getFontString,
  getLineHeight,
  isTransparent,
} from "@excalidraw/common";

import { getLineHeightInPx } from "./textMeasurements";
import { getWrappedTextLines } from "./textWrapping";

import type { ExcalidrawTableElement, TableCell } from "./types";

/**
 * Geometry and drawing for a table, which is one element owning a whole grid.
 *
 * The grid is stored as fractions — `colWidths` and `rowHeights` each sum to 1
 * — and multiplied by the element's `width`/`height` here, at draw time. Two
 * consequences, and they are the reason for the design:
 *
 *  - the ordinary bounding-box resize scales the table correctly with no
 *    table-specific code anywhere in `resizeElements.ts`, and
 *  - a column drag cannot make cells overlap, because it moves weight between
 *    two neighbours and the total is always 1. The previous composed
 *    implementation had no such invariant and overlapping cells were its most
 *    reported defect.
 */

/** Padding between a cell's edge and its text, in scene units. */
export const CELL_PADDING = 6;

/** Below this on-screen width a column's text is not worth drawing. */
const MIN_LEGIBLE_PX = 12;

export const DEFAULT_CELL_FONT_SIZE = 16;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Running offsets from a fraction array: [0, f0, f0+f1, ...] scaled by total. */
const offsets = (fractions: readonly number[], total: number): number[] => {
  const out: number[] = [0];
  let acc = 0;
  for (const fraction of fractions) {
    acc += fraction * total;
    out.push(acc);
  }
  return out;
};

export const columnOffsets = (element: ExcalidrawTableElement) =>
  offsets(element.colWidths, element.width);

export const rowOffsets = (element: ExcalidrawTableElement) =>
  offsets(element.rowHeights, element.height);

/** A cell's box in element-local coordinates. */
export const getCellRect = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
): CellRect => {
  const xs = columnOffsets(element);
  const ys = rowOffsets(element);
  return {
    x: xs[col] ?? 0,
    y: ys[row] ?? 0,
    width: (xs[col + 1] ?? 0) - (xs[col] ?? 0),
    height: (ys[row + 1] ?? 0) - (ys[row] ?? 0),
  };
};

export const getCell = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
): TableCell | null => element.cells[row]?.[col] ?? null;

export const tableRowCount = (element: ExcalidrawTableElement) =>
  element.cells.length;

export const tableColCount = (element: ExcalidrawTableElement) =>
  element.cells[0]?.length ?? 0;

/**
 * Which cell contains a point given in element-local coordinates.
 *
 * Returns null outside the grid. Callers are responsible for un-rotating the
 * pointer first — see `TableElementEditor`.
 */
export const getCellAt = (
  element: ExcalidrawTableElement,
  localX: number,
  localY: number,
): { row: number; col: number } | null => {
  if (
    localX < 0 ||
    localY < 0 ||
    localX > element.width ||
    localY > element.height
  ) {
    return null;
  }
  const xs = columnOffsets(element);
  const ys = rowOffsets(element);

  let col = -1;
  for (let i = 0; i < xs.length - 1; i++) {
    if (localX >= xs[i]! && localX <= xs[i + 1]!) {
      col = i;
      break;
    }
  }
  let row = -1;
  for (let i = 0; i < ys.length - 1; i++) {
    if (localY >= ys[i]! && localY <= ys[i + 1]!) {
      row = i;
      break;
    }
  }
  return row >= 0 && col >= 0 ? { row, col } : null;
};

/**
 * Move weight between two adjacent columns.
 *
 * The two neighbours' fractions are redistributed and everything else is left
 * alone, so the total stays 1 and the table's outer width never changes. Both
 * columns are floored at `minFraction`, which is what stops a drag past the
 * neighbour's edge from inverting it — the failure that produced overlapping
 * cells before.
 */
export const resizeColumn = (
  element: ExcalidrawTableElement,
  index: number,
  deltaFraction: number,
  minFraction = 0.02,
): readonly number[] => {
  const widths = [...element.colWidths];
  const left = widths[index];
  const right = widths[index + 1];
  if (left === undefined || right === undefined) {
    return element.colWidths;
  }
  const clamped = Math.max(
    -(left - minFraction),
    Math.min(right - minFraction, deltaFraction),
  );
  widths[index] = left + clamped;
  widths[index + 1] = right - clamped;
  return widths;
};

export const resizeRow = (
  element: ExcalidrawTableElement,
  index: number,
  deltaFraction: number,
  minFraction = 0.02,
): readonly number[] => {
  const heights = [...element.rowHeights];
  const top = heights[index];
  const bottom = heights[index + 1];
  if (top === undefined || bottom === undefined) {
    return element.rowHeights;
  }
  const clamped = Math.max(
    -(top - minFraction),
    Math.min(bottom - minFraction, deltaFraction),
  );
  heights[index] = top + clamped;
  heights[index + 1] = bottom - clamped;
  return heights;
};

/** Move a whole row to a new index, carrying its contents and its height. */
export const moveRow = (
  element: ExcalidrawTableElement,
  from: number,
  to: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const rows = tableRowCount(element);
  if (from === to || from < 0 || to < 0 || from >= rows || to >= rows) {
    return { cells: element.cells, rowHeights: element.rowHeights };
  }
  const cells = [...element.cells];
  const heights = [...element.rowHeights];
  const [cellRow] = cells.splice(from, 1);
  const [height] = heights.splice(from, 1);
  cells.splice(to, 0, cellRow!);
  heights.splice(to, 0, height!);
  return { cells, rowHeights: heights };
};

export const moveColumn = (
  element: ExcalidrawTableElement,
  from: number,
  to: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  if (from === to || from < 0 || to < 0 || from >= cols || to >= cols) {
    return { cells: element.cells, colWidths: element.colWidths };
  }
  const widths = [...element.colWidths];
  const [width] = widths.splice(from, 1);
  widths.splice(to, 0, width!);

  const cells = element.cells.map((row) => {
    const next = [...row];
    const [cell] = next.splice(from, 1);
    next.splice(to, 0, cell!);
    return next;
  });
  return { cells, colWidths: widths };
};

const emptyCell = (): TableCell => ({ text: "", fill: null });

/** Insert a row, sharing the new row's height out of the existing ones. */
export const insertRow = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const cols = tableColCount(element);
  const rows = tableRowCount(element);
  const share = 1 / (rows + 1);
  // Existing rows keep their relative proportions and give up `share` between
  // them, so the table's height is unchanged and nothing jumps.
  const heights = element.rowHeights.map((h) => h * (1 - share));
  heights.splice(at, 0, share);

  const cells = [...element.cells];
  cells.splice(at, 0, Array.from({ length: cols }, emptyCell));
  return { cells, rowHeights: heights };
};

export const insertColumn = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  const share = 1 / (cols + 1);
  const widths = element.colWidths.map((w) => w * (1 - share));
  widths.splice(at, 0, share);

  const cells = element.cells.map((row) => {
    const next = [...row];
    next.splice(at, 0, emptyCell());
    return next;
  });
  return { cells, colWidths: widths };
};

/** Remove a row, giving its height back to the survivors proportionally. */
export const deleteRow = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const rows = tableRowCount(element);
  // A table with no rows is not a table; refuse rather than produce one.
  if (rows <= 1) {
    return { cells: element.cells, rowHeights: element.rowHeights };
  }
  const heights = [...element.rowHeights];
  const [removed] = heights.splice(at, 1);
  const remaining = 1 - (removed ?? 0);
  const cells = [...element.cells];
  cells.splice(at, 1);
  return {
    cells,
    rowHeights: heights.map((h) =>
      remaining > 0 ? h / remaining : 1 / heights.length,
    ),
  };
};

export const deleteColumn = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  if (cols <= 1) {
    return { cells: element.cells, colWidths: element.colWidths };
  }
  const widths = [...element.colWidths];
  const [removed] = widths.splice(at, 1);
  const remaining = 1 - (removed ?? 0);
  const cells = element.cells.map((row) => {
    const next = [...row];
    next.splice(at, 1);
    return next;
  });
  return {
    cells,
    colWidths: widths.map((w) =>
      remaining > 0 ? w / remaining : 1 / widths.length,
    ),
  };
};

/** Set one cell's text or fill without disturbing the rest of the grid. */
export const withCell = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
  patch: Partial<TableCell>,
): ExcalidrawTableElement["cells"] =>
  element.cells.map((cells, r) =>
    r === row
      ? cells.map((cell, c) => (c === col ? { ...cell, ...patch } : cell))
      : cells,
  );

/**
 * Draw the table.
 *
 * Called from `drawElementOnCanvas` with the context already translated to the
 * element's origin and scaled for zoom and device pixel ratio, so everything
 * here is in element-local units starting at (0, 0).
 */
export const drawTableOnCanvas = (
  element: ExcalidrawTableElement,
  context: CanvasRenderingContext2D,
) => {
  const xs = columnOffsets(element);
  const ys = rowOffsets(element);
  const rows = tableRowCount(element);
  const cols = tableColCount(element);
  const isMatrix = element.variant === "matrix";

  const fontFamily = isMatrix ? FONT_FAMILY.Cascadia : FONT_FAMILY.Excalifont;
  const fontSize = DEFAULT_CELL_FONT_SIZE;
  const font = getFontString({ fontSize, fontFamily });
  const lineHeightPx = getLineHeightInPx(fontSize, getLineHeight(fontFamily));

  context.save();

  // Fills first, so the grid lines sit on top of them rather than being
  // half-covered by the next cell's background.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = getCell(element, row, col);
      const fill =
        cell?.fill ??
        (element.headerRow && row === 0 ? element.backgroundColor : null);
      if (!fill || isTransparent(fill)) {
        continue;
      }
      context.fillStyle = fill;
      context.fillRect(
        xs[col]!,
        ys[row]!,
        xs[col + 1]! - xs[col]!,
        ys[row + 1]! - ys[row]!,
      );
    }
  }

  context.strokeStyle = element.strokeColor;
  context.lineWidth = element.strokeWidth;
  context.beginPath();
  for (const x of xs) {
    context.moveTo(x, 0);
    context.lineTo(x, element.height);
  }
  for (const y of ys) {
    context.moveTo(0, y);
    context.lineTo(element.width, y);
  }
  context.stroke();

  context.fillStyle = element.strokeColor;
  context.font = font;
  context.textBaseline = "top";

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const text = getCell(element, row, col)?.text ?? "";
      if (!text) {
        continue;
      }
      const cellWidth = xs[col + 1]! - xs[col]!;
      const cellHeight = ys[row + 1]! - ys[row]!;
      const maxWidth = cellWidth - CELL_PADDING * 2;
      // A column dragged very narrow would otherwise spend layout time
      // wrapping text into a sliver nobody can read.
      if (maxWidth < MIN_LEGIBLE_PX) {
        continue;
      }

      const lines = getWrappedTextLines(text, font, maxWidth);
      // Clip so an overfull cell is visibly cut off at its own border rather
      // than bleeding into its neighbour and looking like a rendering bug.
      context.save();
      context.beginPath();
      context.rect(xs[col]!, ys[row]!, cellWidth, cellHeight);
      context.clip();

      const isHeader = element.headerRow && row === 0;
      context.font = isHeader
        ? getFontString({ fontSize, fontFamily }).replace(
            `${fontSize}px`,
            `bold ${fontSize}px`,
          )
        : font;

      lines.forEach((line, index) => {
        const y = ys[row]! + CELL_PADDING + index * lineHeightPx;
        if (y > ys[row + 1]!) {
          return;
        }
        // Numbers right-align, which is how a matrix is read; prose does not.
        const x = isMatrix
          ? xs[col + 1]! - CELL_PADDING - context.measureText(line.text).width
          : xs[col]! + CELL_PADDING;
        context.fillText(line.text, x, y);
      });
      context.restore();
    }
  }

  context.restore();
};
