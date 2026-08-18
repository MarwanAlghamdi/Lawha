import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { buildTable, tableIdOf } from "./tableBuild";
import { cellKey, readTable } from "./tableModel";
import { snapAllTables, snapStrayCells, translateTable } from "./tableSnap";

const grid = (rows = 3, cols = 3) => {
  const elements = buildTable({
    x: 0,
    y: 0,
    rows,
    cols,
    colWidth: 100,
    rowHeight: 40,
    header: false,
  });
  return { elements, tableId: tableIdOf(elements)! };
};

const move = (
  elements: readonly ExcalidrawElement[],
  row: number,
  col: number,
  dx: number,
  dy: number,
) => {
  const model = readTable(elements, tableIdOf(elements)!)!;
  const target = model.cells.get(cellKey(row, col))!.element.id;
  return elements.map((el) =>
    el.id === target ? { ...el, x: el.x + dx, y: el.y + dy } : el,
  );
};

const at = (
  elements: readonly ExcalidrawElement[],
  tableId: string,
  row: number,
  col: number,
) => readTable(elements, tableId)!.cells.get(cellKey(row, col))!.element;

describe("snapStrayCells", () => {
  it("returns the same array when nothing moved", () => {
    const { elements, tableId } = grid();
    // Reference equality, so the caller can skip the scene write entirely.
    expect(snapStrayCells(elements, tableId)).toBe(elements);
  });

  it("returns a dragged cell to its row and column", () => {
    const { elements, tableId } = grid();
    const strayed = move(elements, 1, 1, 350, -220);

    const snapped = snapStrayCells(strayed, tableId);

    expect(at(snapped, tableId, 1, 1).x).toBe(100);
    expect(at(snapped, tableId, 1, 1).y).toBe(40);
  });

  it("is not dragged toward the outlier by the outlier", () => {
    // A mean would move every other cell's "expected" position to meet the
    // stray one. The cells that did not move must not budge.
    const { elements, tableId } = grid();
    const strayed = move(elements, 0, 0, 1000, 1000);

    const snapped = snapStrayCells(strayed, tableId);

    expect(at(snapped, tableId, 2, 2).x).toBe(200);
    expect(at(snapped, tableId, 2, 2).y).toBe(80);
    expect(at(snapped, tableId, 0, 0).x).toBe(0);
    expect(at(snapped, tableId, 0, 0).y).toBe(0);
  });

  it("ignores a nudge inside the tolerance", () => {
    const { elements, tableId } = grid();
    const nudged = move(elements, 0, 1, 3, 2);

    expect(snapStrayCells(nudged, tableId)).toBe(nudged);
  });

  it("brings the cell's text along with it", () => {
    const elements = buildTable({
      x: 0,
      y: 0,
      rows: 2,
      cols: 2,
      colWidth: 100,
      rowHeight: 40,
      header: false,
      data: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    const tableId = tableIdOf(elements)!;
    const model = readTable(elements, tableId)!;
    const cell = model.cells.get(cellKey(1, 1))!;
    const textId = cell.text!.id;
    const textXBefore = cell.text!.x;

    // A real drag carries the bound text with the container, so the fixture
    // must too — moving the rectangle alone is a state the editor never
    // produces, and testing against it would pin the wrong behaviour.
    const strayed = elements.map((el) =>
      el.id === cell.element.id || el.id === textId
        ? { ...el, x: el.x + 300 }
        : el,
    );
    const snapped = snapStrayCells(strayed, tableId);

    // The rectangle went back, so the label must have gone back with it — a
    // bound text is a binding, not a parent transform.
    expect(at(snapped, tableId, 1, 1).x).toBe(100);
    expect(snapped.find((el) => el.id === textId)!.x).toBe(textXBefore);
  });

  it("leaves a grid too small to have a majority alone", () => {
    const { elements, tableId } = grid(1, 2);
    const strayed = move(elements, 0, 1, 90, 90);

    expect(snapStrayCells(strayed, tableId)).toBe(strayed);
  });

  it("does not touch another table", () => {
    const a = grid();
    const b = grid();
    const all = [...a.elements, ...b.elements];
    const strayed = all.map((el) =>
      el.id === at(b.elements, b.tableId, 0, 0).id
        ? { ...el, x: el.x + 400 }
        : el,
    );

    const snapped = snapStrayCells(strayed, a.tableId);

    expect(at(snapped, b.tableId, 0, 0).x).toBe(400);
  });
});

describe("snapAllTables", () => {
  it("fixes every grid in the scene at once", () => {
    const a = grid();
    const b = grid();
    let all: readonly ExcalidrawElement[] = [...a.elements, ...b.elements];
    all = all.map((el) =>
      el.id === at(a.elements, a.tableId, 0, 0).id ||
      el.id === at(b.elements, b.tableId, 2, 2).id
        ? { ...el, x: el.x + 500 }
        : el,
    );

    const snapped = snapAllTables(all);

    expect(at(snapped, a.tableId, 0, 0).x).toBe(0);
    expect(at(snapped, b.tableId, 2, 2).x).toBe(200);
  });

  it("is a no-op on a clean scene", () => {
    const { elements } = grid();
    expect(snapAllTables(elements)).toBe(elements);
  });
});

describe("translateTable", () => {
  it("moves every cell and label together", () => {
    const elements = buildTable({
      x: 0,
      y: 0,
      rows: 2,
      cols: 2,
      colWidth: 100,
      rowHeight: 40,
      header: false,
      data: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    const tableId = tableIdOf(elements)!;

    const moved = translateTable(elements, tableId, 50, 25);
    const model = readTable(moved, tableId)!;

    expect(model.bounds.x).toBe(50);
    expect(model.bounds.y).toBe(25);
    // and the labels came too — a stranded label is the bug this guards
    expect(model.cells.get(cellKey(0, 0))!.text!.x).toBeGreaterThanOrEqual(50);
  });

  it("leaves other elements where they are", () => {
    const a = grid(2, 2);
    const b = grid(2, 2);
    const moved = translateTable(
      [...a.elements, ...b.elements],
      a.tableId,
      100,
      0,
    );

    expect(readTable(moved, b.tableId)!.bounds.x).toBe(0);
  });
});
