/**
 * Grid mutations.
 *
 * Every operation takes the whole element array and returns a new one, so the
 * caller can hand the result straight to `updateScene`. Nothing mutates in place.
 *
 * **Ids are preserved wherever an element survives.** `reconcileElements` keys on
 * id and resolves last-writer-wins per element, so rebuilding a table with fresh
 * ids would look to every peer like twelve deletions and twelve insertions rather
 * than one edit. Structural changes therefore re-tag and reposition the cells that
 * remain, and only mint ids for cells that genuinely did not exist before.
 *
 * Removal marks `isDeleted` rather than dropping the element from the array. A
 * cell that simply vanished from the local scene would be reinstated by the next
 * peer to broadcast it — `reconcileElements` never deletes, it unions.
 *
 * Cells are ungrouped by design (see `tableBuild.ts`), so nothing here maintains
 * a `groupIds` entry. Cohesion is the overlay's job.
 */
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { buildTable } from "./tableBuild";
import { LAWHA_KEY, cellKey, readCellTag, readTable } from "./tableModel";

import type { CellTag, TableModel } from "./tableModel";

export interface CellRef {
  row: number;
  col: number;
}

/** Column width taken from a real cell, so a resized grid stays consistent. */
const colWidthOf = (model: TableModel) =>
  model.cells.get(cellKey(0, 0))?.element.width ??
  model.bounds.width / model.cols;

const rowHeightOf = (model: TableModel) =>
  model.cells.get(cellKey(0, 0))?.element.height ??
  model.bounds.height / model.rows;

const retag = (element: ExcalidrawElement, patch: Partial<CellTag>) => {
  const tag = readCellTag(element);
  if (!tag) {
    return element;
  }
  return newElementWith(element, {
    customData: { ...element.customData, [LAWHA_KEY]: { ...tag, ...patch } },
  });
};

/** Elements belonging to one grid, plus the text bound into its cells. */
const partition = (elements: readonly ExcalidrawElement[], tableId: string) => {
  const mine = new Set<string>();
  for (const element of elements) {
    if (readCellTag(element)?.tableId === tableId) {
      mine.add(element.id);
    }
  }
  const textOf = new Map<string, string>();
  for (const element of elements) {
    const containerId = (element as { containerId?: string | null })
      .containerId;
    if (element.type === "text" && containerId && mine.has(containerId)) {
      textOf.set(containerId, element.id);
    }
  }
  return { mine, textOf };
};

/**
 * Paint a background onto specific cells.
 *
 * This is the "colorize each cell" affordance, and it is deliberately just a
 * `backgroundColor` on a rectangle — which is why it survives export, print, and
 * a client that has never heard of Lawha.
 */
export const setCellFill = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  targets: readonly CellRef[],
  backgroundColor: string,
): ExcalidrawElement[] => {
  const wanted = new Set(targets.map((t) => cellKey(t.row, t.col)));
  return elements.map((element) => {
    const tag = readCellTag(element);
    if (
      !tag ||
      tag.tableId !== tableId ||
      !wanted.has(cellKey(tag.row, tag.col))
    ) {
      return element;
    }
    return newElementWith(element, { backgroundColor });
  });
};

/** Mark row 0 as a header, or stop doing so. */
export const setHeaderRow = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  header: boolean,
  headerBackground: string,
  plainBackground: string,
): ExcalidrawElement[] =>
  elements.map((element) => {
    const tag = readCellTag(element);
    if (!tag || tag.tableId !== tableId || tag.row !== 0) {
      return element;
    }
    return newElementWith(retag(element, { header }), {
      backgroundColor: header ? headerBackground : plainBackground,
    });
  });

/**
 * Insert a row. `at` is the index the new row will occupy; `model.rows` appends.
 */
export const addRow = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  at: number,
): ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  if (!model || at < 0 || at > model.rows) {
    return [...elements];
  }
  const rowHeight = rowHeightOf(model);
  const { mine, textOf } = partition(elements, tableId);
  const shiftedText = new Map<string, number>();

  for (const cell of model.cells.values()) {
    if (cell.tag.row >= at) {
      const textId = textOf.get(cell.element.id);
      if (textId) {
        shiftedText.set(textId, rowHeight);
      }
    }
  }

  const shifted = elements.map((element) => {
    if (shiftedText.has(element.id)) {
      return newElementWith(element, {
        y: element.y + shiftedText.get(element.id)!,
      });
    }
    const tag = readCellTag(element);
    if (
      !tag ||
      tag.tableId !== tableId ||
      tag.row < at ||
      !mine.has(element.id)
    ) {
      return element;
    }
    return newElementWith(retag(element, { row: tag.row + 1 }), {
      y: element.y + rowHeight,
    });
  });

  const fresh = buildTable({
    x: model.bounds.x,
    y: model.bounds.y + at * rowHeight,
    rows: 1,
    cols: model.cols,
    colWidth: colWidthOf(model),
    rowHeight,
    header: false,
    kind: model.kind,
    tableId,
  }).map((element) => retag(element, { row: at }));

  return [...shifted, ...fresh];
};

/** Insert a column. `at` is the index the new column will occupy. */
export const addColumn = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  at: number,
): ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  if (!model || at < 0 || at > model.cols) {
    return [...elements];
  }
  const colWidth = colWidthOf(model);
  const { mine, textOf } = partition(elements, tableId);
  const shiftedText = new Map<string, number>();

  for (const cell of model.cells.values()) {
    if (cell.tag.col >= at) {
      const textId = textOf.get(cell.element.id);
      if (textId) {
        shiftedText.set(textId, colWidth);
      }
    }
  }

  const shifted = elements.map((element) => {
    if (shiftedText.has(element.id)) {
      return newElementWith(element, {
        x: element.x + shiftedText.get(element.id)!,
      });
    }
    const tag = readCellTag(element);
    if (
      !tag ||
      tag.tableId !== tableId ||
      tag.col < at ||
      !mine.has(element.id)
    ) {
      return element;
    }
    return newElementWith(retag(element, { col: tag.col + 1 }), {
      x: element.x + colWidth,
    });
  });

  const fresh: ExcalidrawElement[] = [];
  for (let row = 0; row < model.rows; row++) {
    const built = buildTable({
      x: model.bounds.x + at * colWidth,
      y: model.bounds.y + row * rowHeightOf(model),
      rows: 1,
      cols: 1,
      colWidth,
      rowHeight: rowHeightOf(model),
      header: false,
      kind: model.kind,
      tableId,
    }).map((element) => retag(element, { row, col: at }));
    fresh.push(...built);
  }

  return [...shifted, ...fresh];
};

const removeLine = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  axis: "row" | "col",
  at: number,
): ExcalidrawElement[] => {
  const model = readTable(elements, tableId);
  if (!model) {
    return [...elements];
  }
  const extent = axis === "row" ? model.rows : model.cols;
  // Refuse to empty the grid: a table with no rows is not a table, it is a
  // handful of orphaned handles with nothing under them.
  if (extent <= 1 || at < 0 || at >= extent) {
    return [...elements];
  }

  const step = axis === "row" ? rowHeightOf(model) : colWidthOf(model);
  const { textOf } = partition(elements, tableId);
  const doomedText = new Set<string>();
  const shiftedText = new Set<string>();

  for (const cell of model.cells.values()) {
    const index = axis === "row" ? cell.tag.row : cell.tag.col;
    const textId = textOf.get(cell.element.id);
    if (!textId) {
      continue;
    }
    if (index === at) {
      doomedText.add(textId);
    } else if (index > at) {
      shiftedText.add(textId);
    }
  }

  return elements.map((element) => {
    if (doomedText.has(element.id)) {
      return newElementWith(element, { isDeleted: true });
    }
    if (shiftedText.has(element.id)) {
      return newElementWith(
        element,
        axis === "row" ? { y: element.y - step } : { x: element.x - step },
      );
    }
    const tag = readCellTag(element);
    if (!tag || tag.tableId !== tableId) {
      return element;
    }
    const index = axis === "row" ? tag.row : tag.col;
    if (index === at) {
      return newElementWith(element, { isDeleted: true });
    }
    if (index < at) {
      return element;
    }
    const patch = axis === "row" ? { row: tag.row - 1 } : { col: tag.col - 1 };
    return newElementWith(
      retag(element, patch),
      axis === "row" ? { y: element.y - step } : { x: element.x - step },
    );
  });
};

export const deleteRow = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  at: number,
) => removeLine(elements, tableId, "row", at);

export const deleteColumn = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  at: number,
) => removeLine(elements, tableId, "col", at);

/** Delete the whole grid, cells and labels alike. */
export const deleteTable = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
): ExcalidrawElement[] => {
  const { mine, textOf } = partition(elements, tableId);
  const doomed = new Set([...mine, ...textOf.values()]);
  return elements.map((element) =>
    doomed.has(element.id)
      ? newElementWith(element, { isDeleted: true })
      : element,
  );
};
