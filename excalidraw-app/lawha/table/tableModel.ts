/**
 * The logical grid, read back out of ordinary canvas elements.
 *
 * A Lawha table is not an element type — it is a set of rectangles, each with a
 * bound text label, each tagged on `customData` with where it sits in the grid.
 * ADR 0023 has the reasoning; the short version is that `restore.ts` deletes an
 * element whose `type` it does not recognise and then the client saves that
 * deletion back, so a native `table` type would destroy boards for anyone on an
 * older bundle. `customData` is the one field that survives a client which knows
 * nothing about it (`packages/excalidraw/data/restore.ts:472-475`).
 *
 * Everything here is pure and takes elements as an argument, so the whole model
 * is testable without a canvas.
 */
import type { ExcalidrawElement } from "@excalidraw/element/types";

/** The single key Lawha owns inside `customData`. Namespaced so upstream, or a
 * future Lawha feature, can put its own things beside ours without a collision. */
export const LAWHA_KEY = "lawha";

export type GridKind = "table-cell" | "matrix-cell" | "tensor";

/** What one tagged element knows about itself. */
export interface CellTag {
  kind: GridKind;
  /** Stable across the whole grid; this is what makes a pile of rectangles a table. */
  tableId: string;
  row: number;
  col: number;
  header?: boolean;
  /** Only on `matrix-cell`: the parsed numeric value, for heatmap shading. */
  value?: number | null;
}

export interface Cell {
  tag: CellTag;
  /** The rectangle. */
  element: ExcalidrawElement;
  /** The bound text element, if the cell has one yet. */
  text: ExcalidrawElement | null;
}

export interface TableModel {
  tableId: string;
  kind: GridKind;
  rows: number;
  cols: number;
  /** Keyed `${row}:${col}`. Sparse on purpose — see `readTable`. */
  cells: Map<string, Cell>;
  /** Scene-coordinate bounds of the whole grid. */
  bounds: { x: number; y: number; width: number; height: number };
}

export const cellKey = (row: number, col: number) => `${row}:${col}`;

/**
 * Read Lawha's tag off an element, or null if it carries none.
 *
 * Defensive about shape rather than trusting it: `customData` is `Record<string,
 * any>` and round-trips through JSON, other clients, and hand-edited files, so a
 * malformed tag is a thing that can actually arrive. A bad tag makes the element
 * an ordinary rectangle again, which is a safe thing for it to be.
 */
export const readCellTag = (element: ExcalidrawElement): CellTag | null => {
  const raw = element.customData?.[LAWHA_KEY];
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { kind, tableId, row, col } = raw as Partial<CellTag>;
  if (
    (kind !== "table-cell" && kind !== "matrix-cell" && kind !== "tensor") ||
    typeof tableId !== "string" ||
    !tableId ||
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    (row as number) < 0 ||
    (col as number) < 0
  ) {
    return null;
  }
  return {
    kind,
    tableId,
    row: row as number,
    col: col as number,
    header: (raw as CellTag).header === true,
    value:
      typeof (raw as CellTag).value === "number"
        ? (raw as CellTag).value
        : null,
  };
};

export const isGridElement = (element: ExcalidrawElement) =>
  readCellTag(element) !== null;

/** Every distinct grid present in the scene, in first-appearance order. */
export const findTableIds = (
  elements: readonly ExcalidrawElement[],
): string[] => {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    const tag = readCellTag(element);
    if (tag && !known.has(tag.tableId)) {
      known.add(tag.tableId);
      seen.push(tag.tableId);
    }
  }
  return seen;
};

/**
 * Rebuild one grid from the scene.
 *
 * **Tolerates holes, and that is deliberate.** `reconcileElements` resolves
 * last-writer-wins per element with no notion of a group, so two people editing
 * one table concurrently can land a mix of both edits and, briefly, a grid with a
 * cell missing. Throwing here would turn a recoverable render into a crash. The
 * cost of composition is stated in ADR 0023; this function is where it is paid.
 *
 * `rows`/`cols` come from the highest index actually present, so a table whose
 * last row lost a race renders one row shorter rather than not at all.
 */
export const readTable = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): TableModel | null => {
  const cells = new Map<string, Cell>();
  /** containerId -> text element, so each cell finds its own label in one pass. */
  const textByContainer = new Map<string, ExcalidrawElement>();
  let kind: GridKind = "table-cell";
  let rows = 0;
  let cols = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    const containerId = (element as { containerId?: string | null })
      .containerId;
    if (element.type === "text" && containerId) {
      textByContainer.set(containerId, element);
    }
  }

  for (const element of elements) {
    if (element.isDeleted || element.type === "text") {
      continue;
    }
    const tag = readCellTag(element);
    if (!tag || tag.tableId !== tableId) {
      continue;
    }
    kind = tag.kind;
    rows = Math.max(rows, tag.row + 1);
    cols = Math.max(cols, tag.col + 1);
    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + element.width);
    maxY = Math.max(maxY, element.y + element.height);
    cells.set(cellKey(tag.row, tag.col), {
      tag,
      element,
      text: textByContainer.get(element.id) ?? null,
    });
  }

  if (cells.size === 0) {
    return null;
  }

  return {
    tableId,
    kind,
    rows,
    cols,
    cells,
    bounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
};

/** The text a cell currently shows, or "" when it has no label yet. */
export const cellText = (cell: Cell | undefined): string =>
  ((cell?.text as { text?: string } | null)?.text ?? "").trim();

/** Every element belonging to a grid, rectangles and their labels alike. */
export const tableElementIds = (model: TableModel): Set<string> => {
  const ids = new Set<string>();
  for (const cell of model.cells.values()) {
    ids.add(cell.element.id);
    if (cell.text) {
      ids.add(cell.text.id);
    }
  }
  return ids;
};

/** The ids in one column, for "select this column" from the overlay handle. */
export const columnElementIds = (model: TableModel, col: number): string[] => {
  const ids: string[] = [];
  for (let row = 0; row < model.rows; row++) {
    const cell = model.cells.get(cellKey(row, col));
    if (cell) {
      ids.push(cell.element.id);
    }
  }
  return ids;
};

/** The ids in one row. */
export const rowElementIds = (model: TableModel, row: number): string[] => {
  const ids: string[] = [];
  for (let col = 0; col < model.cols; col++) {
    const cell = model.cells.get(cellKey(row, col));
    if (cell) {
      ids.push(cell.element.id);
    }
  }
  return ids;
};
