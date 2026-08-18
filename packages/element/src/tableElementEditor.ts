import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { getElementAbsoluteCoords } from "./bounds";
import {
  columnOffsets,
  getCellAt,
  gridLines,
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

/**
 * Anchor thickness in SCREEN pixels, by pointer type.
 *
 * The same ladder `transformHandleSizes` uses, for the same reason: a finger
 * is not a mouse pointer. A constant 12 here — which is what this was — put a
 * 12px target next to a 28px transform handle on touch.
 */
export const ANCHOR_SIZES: Record<string, number> = {
  mouse: 10,
  pen: 16,
  touch: 28,
};

/** Default thickness, for the renderer, which does not know the pointer. */
export const ANCHOR_THICKNESS = ANCHOR_SIZES.mouse!;

/**
 * Gap between the element's edge and the anchor strip, in screen pixels.
 *
 * Must clear the selection border, which `renderSelectionBorder` draws at
 * `DEFAULT_TRANSFORM_HANDLE_SPACING * 2 = 4`. The previous value was 2 —
 * identical to `DEFAULT_TRANSFORM_HANDLE_SPACING` — so the strip started
 * inside the transform-handle band and the corner handles landed on top of it.
 */
const ANCHOR_GAP_PX = 5;

/**
 * How far along the edge the first and last anchors are inset, in screen
 * pixels, so they clear the corner transform handles rather than sitting under
 * them. Only the ends need it; a middle column collides with nothing.
 */
const CORNER_CLEARANCE_PX = 9;

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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /**
   * Whether the pointer is over the element.
   *
   * Anchors and the add buttons are revealed by hover rather than drawn
   * permanently — a table at rest should look like a table, not like a table
   * wearing equipment. Notion does the same.
   */
  isHovered: boolean;
}

export const emptyTableEditor = (elementId: string): TableEditorState => ({
  elementId,
  activeCell: null,
  hoveredDivider: null,
  draggingDivider: null,
  draggingAnchor: null,
  selection: null,
  isHovered: false,
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

/**
 * One anchor's box in element-local units, or null when the column is too
 * narrow to carry a usable target.
 *
 * The single source of truth for both drawing and hit-testing: two copies of
 * this arithmetic is how a handle ends up drawn somewhere you cannot click.
 */
export const anchorStrip = (
  element: ExcalidrawTableElement,
  axis: Axis,
  index: number,
  zoom: number,
  pointerType: string,
): Rect | null => {
  const { xs, ys } = gridLines(element);
  const thickness = (ANCHOR_SIZES[pointerType] ?? ANCHOR_THICKNESS) / zoom;
  const gap = ANCHOR_GAP_PX / zoom;
  const clearance = CORNER_CLEARANCE_PX / zoom;
  const bounds = axis === "col" ? xs : ys;
  const count = bounds.length - 1;

  if (index < 0 || index >= count) {
    return null;
  }

  let start = bounds[index]!;
  let end = bounds[index + 1]!;
  if (index === 0) {
    start += clearance;
  }
  if (index === count - 1) {
    end -= clearance;
  }
  // A strip narrower than half a pointer target is not a target. Tied to the
  // pointer size rather than a constant, so a finger and a mouse disagree
  // about what counts as too small in the same direction they disagree about
  // everything else.
  if (end - start < thickness / 2) {
    return null;
  }

  return axis === "col"
    ? {
        x: start,
        y: ys[0]! - gap - thickness,
        width: end - start,
        height: thickness,
      }
    : {
        x: xs[0]! - gap - thickness,
        y: start,
        width: thickness,
        height: end - start,
      };
};

/**
 * The add-a-row and add-a-column buttons, at the trailing edge of the grid.
 *
 * Notion puts adding where you are already looking when you run out of grid,
 * which is why nobody goes to a side panel to add a row. `axis` says what the
 * button adds.
 */
export const plusButtons = (
  element: ExcalidrawTableElement,
  zoom: number,
  pointerType: string,
): (Rect & { axis: Axis })[] => {
  const { xs, ys } = gridLines(element);
  const size = (ANCHOR_SIZES[pointerType] ?? ANCHOR_THICKNESS) / zoom;
  const gap = ANCHOR_GAP_PX / zoom;
  // Pushed clear of the corner transform handle along the edge it sits on —
  // the same clearance the first and last anchors get, and for the same
  // reason: the corner is already spoken for.
  const clear = CORNER_CLEARANCE_PX / zoom;
  return [
    {
      axis: "col",
      x: xs[xs.length - 1]! + gap + clear,
      y: ys[0]! - gap - size,
      width: size,
      height: size,
    },
    {
      axis: "row",
      x: xs[0]! - gap - size,
      y: ys[ys.length - 1]! + gap + clear,
      width: size,
      height: size,
    },
  ];
};

const inRect = (rect: Rect, x: number, y: number) =>
  x >= rect.x &&
  x <= rect.x + rect.width &&
  y >= rect.y &&
  y <= rect.y + rect.height;

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
  pointerType: string = "mouse",
): TableDivider | null => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  const slack = (DIVIDER_HIT_PX * (pointerType === "touch" ? 2.4 : 1)) / zoom;
  const { xs, ys } = gridLines(element);

  if (ly >= ys[0]! - slack && ly <= ys[ys.length - 1]! + slack) {
    for (let i = 1; i < xs.length - 1; i++) {
      if (Math.abs(lx - xs[i]!) <= slack) {
        return { axis: "col", index: i - 1 };
      }
    }
  }
  if (lx >= xs[0]! - slack && lx <= xs[xs.length - 1]! + slack) {
    for (let i = 1; i < ys.length - 1; i++) {
      if (Math.abs(ly - ys[i]!) <= slack) {
        return { axis: "row", index: i - 1 };
      }
    }
  }
  return null;
};

/** The anchor under the cursor, tested against the drawn geometry. */
export const getAnchorUnderCursor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
  zoom: number,
  pointerType: string = "mouse",
): TableAnchor | null => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  const cols = tableColCount(element);
  const rows = tableRowCount(element);

  for (let i = 0; i < cols; i++) {
    const strip = anchorStrip(element, "col", i, zoom, pointerType);
    if (strip && inRect(strip, lx, ly)) {
      return { axis: "col", index: i };
    }
  }
  for (let i = 0; i < rows; i++) {
    const strip = anchorStrip(element, "row", i, zoom, pointerType);
    if (strip && inRect(strip, lx, ly)) {
      return { axis: "row", index: i };
    }
  }
  return null;
};

/**
 * Whether a point lands on any of the table's own interior chrome.
 *
 * Used to swallow a gesture that pointer-down has already dealt with. Without
 * it a double-click on an anchor or an add button falls past the table
 * entirely and lands on the canvas, which creates a text element on top of the
 * chrome that was clicked.
 */
export const isOnTableChrome = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
  zoom: number,
  pointerType: string = "mouse",
): boolean =>
  getAnchorUnderCursor(element, elementsMap, scene, zoom, pointerType) !==
    null ||
  getPlusUnderCursor(element, elementsMap, scene, zoom, pointerType) !== null ||
  getDividerUnderCursor(element, elementsMap, scene, zoom, pointerType) !==
    null;

/** The add button under the cursor, if any. */
export const getPlusUnderCursor = (
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
  scene: GlobalPoint,
  zoom: number,
  pointerType: string = "mouse",
): Axis | null => {
  const [lx, ly] = toLocal(element, elementsMap, scene);
  for (const button of plusButtons(element, zoom, pointerType)) {
    if (inRect(button, lx, ly)) {
      return button.axis;
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
