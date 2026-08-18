import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { buildTable, tableIdOf } from "./tableBuild";
import {
  cellKey,
  cellText,
  columnElementIds,
  findTableIds,
  readCellTag,
  readTable,
  rowElementIds,
} from "./tableModel";

/**
 * The round trip through `restoreElements` is the point of this file.
 *
 * ADR 0023 refuses a native `table` element type because `restore.ts` has no
 * default case: an unknown `type` returns null and is filtered out, and since the
 * client saves back afterwards, the deletion is persisted. These tests are what
 * prove the composed model does not have that failure — they must keep passing
 * for the design to hold.
 */
const roundTrip = (elements: readonly ExcalidrawElement[]) =>
  restoreElements(JSON.parse(JSON.stringify(elements)), null);

describe("buildTable", () => {
  it("creates one rectangle per cell", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 3, cols: 4 });
    const rects = elements.filter((el) => el.type === "rectangle");

    expect(rects).toHaveLength(12);
  });

  it("tags every cell with its own row and column", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 2, cols: 2 });
    const tags = elements
      .filter((el) => el.type === "rectangle")
      .map((el) => readCellTag(el))
      .filter(Boolean);

    expect(tags).toHaveLength(4);
    expect(tags.map((tag) => `${tag!.row}:${tag!.col}`).sort()).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
    ]);
  });

  it("gives every cell in one table the same tableId and group", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 2, cols: 3 });
    const rects = elements.filter((el) => el.type === "rectangle");

    expect(new Set(rects.map((el) => readCellTag(el)!.tableId)).size).toBe(1);
    expect(new Set(rects.map((el) => el.groupIds.join(","))).size).toBe(1);
  });

  it("lays cells out on a regular grid", () => {
    const elements = buildTable({
      x: 100,
      y: 50,
      rows: 2,
      cols: 2,
      colWidth: 120,
      rowHeight: 40,
    });
    const model = readTable(elements, tableIdOf(elements)!)!;

    expect(model.cells.get(cellKey(0, 0))!.element.x).toBe(100);
    expect(model.cells.get(cellKey(0, 1))!.element.x).toBe(220);
    expect(model.cells.get(cellKey(1, 0))!.element.y).toBe(90);
    expect(model.bounds).toEqual({ x: 100, y: 50, width: 240, height: 80 });
  });

  it("keeps every cell the same size even when the text differs", () => {
    // A label on a container with an undefined width auto-sizes the container.
    // Passing explicit dimensions is what stops a long word widening one cell.
    const elements = buildTable({
      x: 0,
      y: 0,
      rows: 1,
      cols: 2,
      data: [["a", "an extremely long piece of cell text"]],
    });
    const rects = elements.filter((el) => el.type === "rectangle");

    expect(rects[0].width).toBe(rects[1].width);
  });

  it("refuses a degenerate grid", () => {
    expect(buildTable({ x: 0, y: 0, rows: 0, cols: 3 })).toEqual([]);
    expect(buildTable({ x: 0, y: 0, rows: 3, cols: 0 })).toEqual([]);
  });
});

describe("readTable", () => {
  it("reads back the text that was built in", () => {
    const data = [
      ["name", "count"],
      ["alpha", "1"],
    ];
    const elements = buildTable({ x: 0, y: 0, rows: 2, cols: 2, data });
    const model = readTable(elements, tableIdOf(elements)!)!;

    expect(cellText(model.cells.get(cellKey(0, 0)))).toBe("name");
    expect(cellText(model.cells.get(cellKey(1, 1)))).toBe("1");
  });

  it("tolerates a hole rather than throwing", () => {
    // reconcileElements is per-element last-writer-wins with no notion of a
    // group, so a cell really can go missing for a moment. ADR 0023 accepts
    // this; a grid with a hole must still render.
    const elements = buildTable({ x: 0, y: 0, rows: 2, cols: 2 });
    const tableId = tableIdOf(elements)!;
    const victim = elements.find(
      (el) => readCellTag(el)?.row === 1 && readCellTag(el)?.col === 1,
    )!;
    const survivors = elements.filter((el) => el.id !== victim.id);

    const model = readTable(survivors, tableId)!;

    expect(model).not.toBeNull();
    expect(model.cells.size).toBe(3);
    expect(model.cells.get(cellKey(1, 1))).toBeUndefined();
  });

  it("ignores elements that carry no tag", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 1, cols: 1 });
    const stranger = { ...elements[0], id: "stranger", customData: undefined };

    expect(
      readTable(
        [...elements, stranger as ExcalidrawElement],
        tableIdOf(elements)!,
      )!.cells.size,
    ).toBe(1);
  });

  it("keeps two tables apart", () => {
    const a = buildTable({ x: 0, y: 0, rows: 1, cols: 2 });
    const b = buildTable({ x: 500, y: 0, rows: 3, cols: 1 });
    const all = [...a, ...b];

    expect(findTableIds(all)).toHaveLength(2);
    expect(readTable(all, tableIdOf(a)!)!.cols).toBe(2);
    expect(readTable(all, tableIdOf(b)!)!.rows).toBe(3);
  });

  it("returns null for an unknown table", () => {
    expect(
      readTable(buildTable({ x: 0, y: 0, rows: 1, cols: 1 }), "nope"),
    ).toBeNull();
  });
});

describe("selection helpers", () => {
  it("collects a column and a row", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 3, cols: 3 });
    const model = readTable(elements, tableIdOf(elements)!)!;

    expect(columnElementIds(model, 1)).toHaveLength(3);
    expect(rowElementIds(model, 2)).toHaveLength(3);
  });
});

describe("surviving restore.ts", () => {
  it("keeps every cell and its tag through a serialise/restore cycle", () => {
    const elements = buildTable({
      x: 0,
      y: 0,
      rows: 3,
      cols: 4,
      data: [
        ["a", "b", "c", "d"],
        ["1", "2", "3", "4"],
        ["5", "6", "7", "8"],
      ],
    });
    const tableId = tableIdOf(elements)!;

    const restored = roundTrip(elements);
    const model = readTable(restored, tableId)!;

    expect(model).not.toBeNull();
    expect(model.rows).toBe(3);
    expect(model.cols).toBe(4);
    expect(model.cells.size).toBe(12);
    expect(cellText(model.cells.get(cellKey(0, 0)))).toBe("a");
    expect(cellText(model.cells.get(cellKey(2, 3)))).toBe("8");
  });

  it("survives repeated restores, the way a board reopened many times does", () => {
    const elements = buildTable({ x: 0, y: 0, rows: 2, cols: 2 });
    const tableId = tableIdOf(elements)!;

    let current: readonly ExcalidrawElement[] = elements;
    for (let i = 0; i < 5; i++) {
      current = roundTrip(current);
    }

    expect(readTable(current, tableId)!.cells.size).toBe(4);
  });

  it("keeps the cells as plain rectangles, so an old client still renders them", () => {
    // The whole point of ADR 0023: nothing here has a type the rest of the world
    // cannot read. If this ever fails, the composed design has leaked.
    const elements = buildTable({
      x: 0,
      y: 0,
      rows: 2,
      cols: 2,
      data: [
        ["x", "y"],
        ["z", "w"],
      ],
    });

    expect(new Set(roundTrip(elements).map((el) => el.type))).toEqual(
      new Set(["rectangle", "text"]),
    );
  });
});
