/**
 * Keeping an ungrouped grid rectangular.
 *
 * Cells are not grouped, so nothing in the editor stops one being dragged out of
 * the table (see `tableBuild.ts` for why that trade was taken). This module is
 * the other half of the bargain: after a drag settles, a displaced cell returns
 * to the position its row and column imply.
 */
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { cellKey, readCellTag, readTable } from "./tableModel";

import type { TableModel } from "./tableModel";

/**
 * How far a cell may sit from its expected place before it counts as displaced.
 *
 * Generous enough to ignore sub-pixel drift and a grid-snapped nudge, tight
 * enough that an actual drag is unambiguous.
 */
export const SNAP_TOLERANCE = 6;

/**
 * The middle value. Used only for cell size, where every sample agrees.
 *
 * Deliberately *not* used to locate a row or column. With two cells in a column
 * the median is the mean, so one dragged cell pulls the expected position
 * halfway out to meet it and the correction lands in empty space. Position is
 * decided by the vote below instead.
 */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

interface Geometry {
  /** Where cell (0,0) sits. */
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
}

/** Cells within half a pixel of each other are the same vote. */
const VOTE_BUCKET = 0.5;

/**
 * Where the grid actually is, decided by majority.
 *
 * Every cell implies an origin: subtract its column times the cell width from
 * its x, and its row times the height from its y. Cells that have not moved all
 * imply the *same* origin; a dragged one implies a different one and is
 * outvoted. That is the whole trick, and it is why this works where a per-column
 * median did not — the evidence is pooled across the entire grid rather than
 * split into columns of two.
 *
 * Returns null below three cells: two cells cannot outvote each other, so a
 * "displaced" cell there is simply where the user put it.
 */
export const gridGeometry = (model: TableModel): Geometry | null => {
  if (model.cells.size < 3) {
    return null;
  }

  const cells = [...model.cells.values()];
  const cellWidth = median(cells.map((cell) => cell.element.width));
  const cellHeight = median(cells.map((cell) => cell.element.height));
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }

  const votes = new Map<string, { x: number; y: number; count: number }>();
  for (const cell of cells) {
    const x = cell.element.x - cell.tag.col * cellWidth;
    const y = cell.element.y - cell.tag.row * cellHeight;
    const key = `${Math.round(x / VOTE_BUCKET)}:${Math.round(y / VOTE_BUCKET)}`;
    const seen = votes.get(key);
    if (seen) {
      seen.count += 1;
    } else {
      votes.set(key, { x, y, count: 1 });
    }
  }

  const winner = [...votes.values()].sort((a, b) => b.count - a.count)[0]!;
  // No majority means the grid has been rearranged rather than nudged, and
  // "correcting" it would be this module inventing a layout nobody asked for.
  if (winner.count < 2 || winner.count * 2 <= cells.length) {
    return null;
  }

  return {
    originX: winner.x,
    originY: winner.y,
    cellWidth,
    cellHeight,
  };
};

/**
 * Return any displaced cell to where its row and column say it belongs.
 *
 * Returns the same array reference when nothing moved, so a caller can skip the
 * scene update entirely rather than writing an identical scene back and handing
 * every peer a version bump for no change.
 */
export const snapStrayCells = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): readonly ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  if (!model) {
    return elements;
  }
  const geometry = gridGeometry(model);
  if (!geometry) {
    return elements;
  }

  const moves = new Map<string, { x: number; y: number }>();
  for (const cell of model.cells.values()) {
    const x = geometry.originX + cell.tag.col * geometry.cellWidth;
    const y = geometry.originY + cell.tag.row * geometry.cellHeight;
    if (
      Math.abs(cell.element.x - x) > SNAP_TOLERANCE ||
      Math.abs(cell.element.y - y) > SNAP_TOLERANCE
    ) {
      moves.set(cell.element.id, { x, y });
    }
  }

  if (moves.size === 0) {
    return elements;
  }

  // The bound text rides with its container; moving the rectangle alone would
  // leave the label behind, because `containerId` is a binding rather than a
  // parent transform.
  const textShift = new Map<string, { dx: number; dy: number }>();
  for (const cell of model.cells.values()) {
    const move = moves.get(cell.element.id);
    if (move && cell.text) {
      textShift.set(cell.text.id, {
        dx: move.x - cell.element.x,
        dy: move.y - cell.element.y,
      });
    }
  }

  return elements.map((element) => {
    const move = moves.get(element.id);
    if (move) {
      return newElementWith(element, { x: move.x, y: move.y });
    }
    const shift = textShift.get(element.id);
    if (shift) {
      return newElementWith(element, {
        x: element.x + shift.dx,
        y: element.y + shift.dy,
      });
    }
    return element;
  });
};

/** Snap every grid in the scene. Cheap when nothing has moved. */
export const snapAllTables = (
  elements: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] => {
  const ids = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    const tag = readCellTag(element);
    // Tensor blocks are one shape made of faces rather than a grid of cells;
    // there is no row/column geometry to hold them to.
    if (tag && tag.kind !== "tensor") {
      ids.add(tag.tableId);
    }
  }
  let next = elements;
  for (const id of ids) {
    next = snapStrayCells(next, id);
  }
  return next;
};

/** Move every element of one grid by a delta — what the overlay's grab bar does. */
export const translateTable = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  dx: number,
  dy: number,
): ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  if (!model) {
    return [...elements];
  }
  const ids = new Set<string>();
  for (const cell of model.cells.values()) {
    ids.add(cell.element.id);
    if (cell.text) {
      ids.add(cell.text.id);
    }
  }
  return elements.map((element) =>
    ids.has(element.id)
      ? newElementWith(element, { x: element.x + dx, y: element.y + dy })
      : element,
  );
};

export { cellKey };
