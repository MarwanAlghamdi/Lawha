import { describe, expect, it } from "vitest";

import { newTableElement } from "../src/newElement";
import {
  columnOffsets,
  deleteColumn,
  deleteRow,
  getCellAt,
  getCellRect,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  resizeColumn,
  resizeRow,
  withCell,
} from "../src/tableElement";

import type { ExcalidrawTableElement } from "../src/types";

const table = (rows = 3, cols = 3, overrides = {}) =>
  newTableElement({
    x: 0,
    y: 0,
    width: 300,
    height: 120,
    rows,
    cols,
    strokeColor: "#000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    ...overrides,
  }) as ExcalidrawTableElement;

const sum = (values: readonly number[]) =>
  values.reduce((total, n) => total + n, 0);

const withWidths = (
  element: ExcalidrawTableElement,
  colWidths: readonly number[],
) => ({ ...element, colWidths } as ExcalidrawTableElement);

describe("a fresh table", () => {
  it("divides itself evenly", () => {
    const t = table(2, 4);
    expect(t.colWidths).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(t.rowHeights).toEqual([0.5, 0.5]);
  });

  it("has a cell for every position", () => {
    const t = table(2, 3);
    expect(t.cells).toHaveLength(2);
    expect(t.cells[0]).toHaveLength(3);
    expect(t.cells[0]![0]).toEqual({ text: "", fill: null });
  });

  it("treats a matrix as the same grid without a header", () => {
    expect(table(2, 2, { variant: "matrix" }).headerRow).toBe(false);
    expect(table(2, 2).headerRow).toBe(true);
  });
});

describe("cell geometry", () => {
  it("places cells edge to edge with no gap and no overlap", () => {
    const t = table(2, 3);
    const a = getCellRect(t, 0, 0);
    const b = getCellRect(t, 0, 1);

    expect(a.x + a.width).toBe(b.x);
    expect(a.width).toBeCloseTo(100);
  });

  it("spans exactly the element's width", () => {
    const t = table(2, 3);
    const last = getCellRect(t, 0, 2);
    expect(last.x + last.width).toBeCloseTo(t.width);
  });

  it("finds the cell under a point", () => {
    const t = table(2, 3);
    expect(getCellAt(t, 150, 30)).toEqual({ row: 0, col: 1 });
    expect(getCellAt(t, 250, 90)).toEqual({ row: 1, col: 2 });
  });

  it("returns null outside the grid", () => {
    const t = table(2, 3);
    expect(getCellAt(t, -5, 30)).toBeNull();
    expect(getCellAt(t, 400, 30)).toBeNull();
  });
});

describe("resizing a column", () => {
  it("moves weight between two neighbours and nothing else", () => {
    const t = table(2, 3);
    const next = resizeColumn(t, 0, 0.1);

    expect(next[0]).toBeCloseTo(0.4333, 3);
    expect(next[1]).toBeCloseTo(0.2333, 3);
    // the third column is untouched — a resize is local
    expect(next[2]).toBeCloseTo(1 / 3, 5);
  });

  it("always sums to 1, so the table's width never changes", () => {
    const t = table(2, 4);
    for (const delta of [0.1, -0.2, 0.9, -5, 0.0001]) {
      expect(sum(resizeColumn(t, 1, delta))).toBeCloseTo(1, 10);
    }
  });

  it("cannot invert a column, which is what made cells overlap", () => {
    // The old composed implementation had no such floor: dragging past the
    // neighbour's edge produced a negative width and the cells drew on top of
    // each other. Here the drag is clamped and both columns stay positive.
    const t = table(2, 3);
    const next = resizeColumn(t, 0, 99);

    expect(next.every((w) => w > 0)).toBe(true);
    expect(sum(next)).toBeCloseTo(1, 10);
  });

  it("clamps in the negative direction too", () => {
    const t = table(2, 3);
    const next = resizeColumn(t, 1, -99);
    expect(next.every((w) => w > 0)).toBe(true);
    expect(sum(next)).toBeCloseTo(1, 10);
  });

  it("leaves an out-of-range index alone", () => {
    const t = table(2, 3);
    expect(resizeColumn(t, 2, 0.1)).toEqual(t.colWidths);
    expect(resizeColumn(t, 9, 0.1)).toEqual(t.colWidths);
  });

  it("keeps cells edge to edge after an uneven resize", () => {
    // The property that matters visually: whatever the fractions are, the
    // rendered boxes still tile the element exactly.
    const t = withWidths(table(2, 3), resizeColumn(table(2, 3), 0, 0.15));
    const xs = columnOffsets(t);

    for (let i = 0; i < xs.length - 1; i++) {
      expect(xs[i + 1]).toBeGreaterThan(xs[i]!);
    }
    expect(xs[xs.length - 1]).toBeCloseTo(t.width, 6);
  });
});

describe("resizing a row", () => {
  it("moves weight between neighbours and always sums to 1", () => {
    const t = table(3, 2);
    const next = resizeRow(t, 0, 0.1);
    expect(sum(next)).toBeCloseTo(1, 10);
    expect(next[2]).toBeCloseTo(1 / 3, 5);
  });
});

describe("reordering", () => {
  it("carries a row's contents and its height", () => {
    let t = table(3, 2);
    t = {
      ...t,
      cells: withCell(t, 0, 0, { text: "first" }),
    } as ExcalidrawTableElement;
    t = { ...t, rowHeights: [0.5, 0.25, 0.25] } as ExcalidrawTableElement;

    const moved = moveRow(t, 0, 2);

    expect(moved.cells[2]![0]!.text).toBe("first");
    expect(moved.rowHeights).toEqual([0.25, 0.25, 0.5]);
    expect(sum(moved.rowHeights)).toBeCloseTo(1, 10);
  });

  it("carries a column's contents and its width", () => {
    let t = table(2, 3);
    t = {
      ...t,
      cells: withCell(t, 1, 0, { text: "left" }),
    } as ExcalidrawTableElement;
    t = { ...t, colWidths: [0.5, 0.25, 0.25] } as ExcalidrawTableElement;

    const moved = moveColumn(t, 0, 2);

    expect(moved.cells[1]![2]!.text).toBe("left");
    expect(moved.colWidths).toEqual([0.25, 0.25, 0.5]);
  });

  it("is a no-op when the index does not move", () => {
    const t = table(3, 2);
    expect(moveRow(t, 1, 1).cells).toBe(t.cells);
  });
});

describe("inserting", () => {
  it("adds a row without changing the table's height", () => {
    const t = table(3, 2);
    const next = insertRow(t, 1);

    expect(next.cells).toHaveLength(4);
    expect(next.cells[1]!.every((cell) => cell.text === "")).toBe(true);
    expect(sum(next.rowHeights)).toBeCloseTo(1, 10);
  });

  it("adds a column to every row", () => {
    const t = table(3, 2);
    const next = insertColumn(t, 0);

    expect(next.cells.every((row) => row.length === 3)).toBe(true);
    expect(sum(next.colWidths)).toBeCloseTo(1, 10);
  });

  it("keeps existing rows in proportion to each other", () => {
    const t = {
      ...table(2, 2),
      rowHeights: [0.75, 0.25],
    } as ExcalidrawTableElement;
    const next = insertRow(t, 2);

    // 0.75 : 0.25 was 3:1 and must still be 3:1 afterwards
    expect(next.rowHeights[0]! / next.rowHeights[1]!).toBeCloseTo(3, 6);
  });
});

describe("deleting", () => {
  it("removes a row and gives its height back", () => {
    const t = table(3, 2);
    const next = deleteRow(t, 1);

    expect(next.cells).toHaveLength(2);
    expect(sum(next.rowHeights)).toBeCloseTo(1, 10);
  });

  it("removes a column from every row", () => {
    const t = table(2, 3);
    const next = deleteColumn(t, 1);

    expect(next.cells.every((row) => row.length === 2)).toBe(true);
    expect(sum(next.colWidths)).toBeCloseTo(1, 10);
  });

  it("refuses to empty the table", () => {
    const one = table(1, 1);
    expect(deleteRow(one, 0).cells).toHaveLength(1);
    expect(deleteColumn(one, 0).cells[0]).toHaveLength(1);
  });

  it("preserves the survivors' contents", () => {
    let t = table(3, 2);
    t = {
      ...t,
      cells: withCell(t, 2, 1, { text: "keep" }),
    } as ExcalidrawTableElement;

    expect(deleteRow(t, 0).cells[1]![1]!.text).toBe("keep");
  });
});

describe("withCell", () => {
  it("changes one cell and shares the rest", () => {
    const t = table(2, 2);
    const cells = withCell(t, 1, 1, { text: "x", fill: "#ffc9c9" });

    expect(cells[1]![1]).toEqual({ text: "x", fill: "#ffc9c9" });
    expect(cells[0]).toBe(t.cells[0]);
  });
});
