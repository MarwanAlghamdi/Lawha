import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { getElementAbsoluteCoords } from "./bounds";
import {
  columnOffsets,
  getCellAt,
  moveColumn,
  moveRow,
  resizeColumn,
  resizeRow,
  rowOffsets,
  tableColCount,
  tableRowCount,
} from "./tableElement";

import type { ExcalidrawTableElement } from "./types";
import type { ElementsMap } from "./types";

/**
 * Interior handles for a table: the anchors that select a row or column, and
 * the dividers between them that resize it.
 *
 * Modelled on `LinearElementEditor`, which is the editor's own precedent for
 * one element owning addressable interior parts. Like it, this holds an id
 * rather than an element, keeps its state in appState, and exposes statics —
 * so it is serialisable, survives a re-render, and cannot go stale against the
 * scene.
 *
 * `TransformHandles` is a closed type of nine bounding-box handles with no
 * extension point, so these are necessarily a parallel system rather than a
 * configuration of that one. The arbitration — interior handles win over the
 * bounding box — lives in App.tsx's pointer-down, exactly as it does for
 * linear points.
 */

/** Half-width of a divider's grab zone, in screen pixels. */
export const DIVIDER_HIT_PX = 5;

/** Thickness of an anchor strip, in screen pixels. */
export const ANCHOR_PX = 12;

export type Axis = "col" | "row";

export interface TableDivider {
  axis: Axis;
  /** Divider `i` sits between index `i` and `i + 1`. */
  index: number;
}

export interface TableAnchor {
  axis: Axis;
  index: number;
}

export interface TableEditorState {
  elementId: string;
  /** The cell being edited, if any. */
  activeCell: { row: number; col: number } | null;
  hoveredDivider: TableDivider | null;
  draggingDivider: TableDivider | null;
  /** An anchor being dragged to reorder its row or column. */
  draggingAnchor: (TableAnchor & { to: number }) | null;
  /** Rows or columns selected in bulk by clicking an anchor. */
  selection: { axis: Axis; indices: readonly number[] } | null;
}

export const emptyTableEditor = (elementId: string): TableEditorState => ({
  elementId,
  activeCell: null,
  hoveredDivider: null,
  draggingDivider: null,
  draggingAnchor: null,
  selection: null,
});

/**
 * A scene point in the element's own unrotated coordinates.
 *
 * Everything else here works in element-local space, so this is the one place
 * rotation is handled — the same approach `LinearElementEditor.createPointAt`
 * takes, and the reason a rotated table's handles stay on its edges.
 */
export const toLocal = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
): LocalPoint => {
  const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
  const [x, y] = pointRotateRads(
    scene,
    pointFrom(cx, cy),
    -element.angle as Radians,
  );
  return pointFrom(x - element.x, y - element.y) as LocalPoint;
};

/** Which cell a scene point falls in, or null outside the table. */
export const getCellUnderCursor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
) => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  return getCellAt(element, lx, ly);
};

/**
 * The divider under the cursor, if any.
 *
 * The grab zone is a constant number of *screen* pixels, so it stays usable at
 * any zoom — the same idiom `getPointIndexUnderCursor` uses. Interior dividers
 * only: the outer edges belong to the bounding box's own resize handles, and
 * two systems fighting over one pixel is how a drag becomes unpredictable.
 */
export const getDividerUnderCursor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
  zoom: number,
): TableDivider | null => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  const slack = DIVIDER_HIT_PX / zoom;

  if (lx < -slack || ly < -slack) {
    return null;
  }

  if (ly >= -slack && ly <= element.height + slack) {
    const xs = columnOffsets(element);
    for (let i = 1; i < xs.length - 1; i++) {
      if (Math.abs(lx - xs[i]!) <= slack) {
        return { axis: "col", index: i - 1 };
      }
    }
  }
  if (lx >= -slack && lx <= element.width + slack) {
    const ys = rowOffsets(element);
    for (let i = 1; i < ys.length - 1; i++) {
      if (Math.abs(ly - ys[i]!) <= slack) {
        return { axis: "row", index: i - 1 };
      }
    }
  }
  return null;
};

/**
 * The anchor under the cursor.
 *
 * Anchors sit just outside the table — column anchors above it, row anchors to
 * its left — which is where a reader already looks for them and keeps them off
 * the cells they address.
 */
export const getAnchorUnderCursor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
  zoom: number,
): TableAnchor | null => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  const strip = ANCHOR_PX / zoom;
  const gap = 2 / zoom;

  if (ly < -gap && ly >= -gap - strip && lx >= 0 && lx <= element.width) {
    const xs = columnOffsets(element);
    for (let i = 0; i < xs.length - 1; i++) {
      if (lx >= xs[i]! && lx <= xs[i + 1]!) {
        return { axis: "col", index: i };
      }
    }
  }
  if (lx < -gap && lx >= -gap - strip && ly >= 0 && ly <= element.height) {
    const ys = rowOffsets(element);
    for (let i = 0; i < ys.length - 1; i++) {
      if (ly >= ys[i]! && ly <= ys[i + 1]!) {
        return { axis: "row", index: i };
      }
    }
  }
  return null;
};

/**
 * Apply a divider drag.
 *
 * The pointer delta is converted to a fraction of the element before being
 * handed to `resizeColumn`/`resizeRow`, which move weight between the two
 * neighbours and floor both. The table's outer size never changes and cells
 * cannot overlap — the defect this whole rewrite exists to remove.
 */
export const applyDividerDrag = (
  element: ExcalidrawTableElement,
  divider: TableDivider,
  deltaScene: number,
): Partial<ExcalidrawTableElement> => {
  if (divider.axis === "col") {
    const fraction = deltaScene / element.width;
    return { colWidths: resizeColumn(element, divider.index, fraction) };
  }
  const fraction = deltaScene / element.height;
  return { rowHeights: resizeRow(element, divider.index, fraction) };
};

/** Which index an anchor drag would drop onto. */
export const dropTargetForAnchor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  anchor: TableAnchor,
  scene: GlobalPoint,
): number => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  const count =
    anchor.axis === "col" ? tableColCount(element) : tableRowCount(element);
  const bounds =
    anchor.axis === "col" ? columnOffsets(element) : rowOffsets(element);
  const along = anchor.axis === "col" ? lx : ly;

  // The slot the pointer is *over*, not the nearest boundary. Dropping a
  // column onto a column means "put it here", and a midpoint rule would send a
  // drop on the right half of a slot to the one after it — which reads as the
  // reorder ignoring you.
  for (let i = 0; i < count; i++) {
    if (along >= bounds[i]! && along <= bounds[i + 1]!) {
      return i;
    }
  }
  return along < bounds[0]! ? 0 : count - 1;
};

/** Apply a reorder. Returns nothing to change when the index has not moved. */
export const applyAnchorDrop = (
  element: ExcalidrawTableElement,
  anchor: TableAnchor,
  to: number,
): Partial<ExcalidrawTableElement> => {
  if (anchor.index === to) {
    return {};
  }
  return anchor.axis === "col"
    ? moveColumn(element, anchor.index, to)
    : moveRow(element, anchor.index, to);
};

/** Every cell in a bulk selection, for the property panel and for filling. */
export const selectedCells = (
  element: ExcalidrawTableElement,
  selection: TableEditorState["selection"],
): { row: number; col: number }[] => {
  if (!selection) {
    return [];
  }
  const rows = tableRowCount(element);
  const cols = tableColCount(element);
  const cells: { row: number; col: number }[] = [];

  for (const index of selection.indices) {
    if (selection.axis === "col") {
      for (let row = 0; row < rows; row++) {
        cells.push({ row, col: index });
      }
    } else {
      for (let col = 0; col < cols; col++) {
        cells.push({ row: index, col });
      }
    }
  }
  return cells;
};

/**
 * Move the active cell with the keyboard.
 *
 * Tab wraps to the next row at the end of a line, the way every spreadsheet
 * does; arrows stop at the edge. A canvas table with no keyboard navigation is
 * unusable for anyone who does not point.
 */
export const nextCell = (
  element: ExcalidrawTableElement,
  from: { row: number; col: number },
  key:
    | "Tab"
    | "ShiftTab"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight",
): { row: number; col: number } => {
  const rows = tableRowCount(element);
  const cols = tableColCount(element);
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max - 1, n));

  switch (key) {
    case "Tab": {
      const flat = from.row * cols + from.col + 1;
      const wrapped = Math.min(flat, rows * cols - 1);
      return { row: Math.floor(wrapped / cols), col: wrapped % cols };
    }
    case "ShiftTab": {
      const flat = Math.max(0, from.row * cols + from.col - 1);
      return { row: Math.floor(flat / cols), col: flat % cols };
    }
    case "ArrowUp":
      return { row: clamp(from.row - 1, rows), col: from.col };
    case "ArrowDown":
      return { row: clamp(from.row + 1, rows), col: from.col };
    case "ArrowLeft":
      return { row: from.row, col: clamp(from.col - 1, cols) };
    default:
      return { row: from.row, col: clamp(from.col + 1, cols) };
  }
};
