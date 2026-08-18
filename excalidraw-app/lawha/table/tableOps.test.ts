import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  CELL_BACKGROUND,
  HEADER_BACKGROUND,
  buildTable,
  tableIdOf,
} from "./tableBuild";
import { cellKey, cellText, readCellTag, readTable } from "./tableModel";
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  deleteTable,
  setCellFill,
  setHeaderRow,
} from "./tableOps";

const grid = (rows: number, cols: number, data?: string[][]) => {
  const elements = buildTable({
    x: 0,
    y: 0,
    rows,
    cols,
    colWidth: 100,
    rowHeight: 40,
    header: false,
    data,
  });
  return { elements, tableId: tableIdOf(elements)! };
};

const live = (elements: readonly ExcalidrawElement[]) =>
  elements.filter((el) => !el.isDeleted);

const model = (elements: readonly ExcalidrawElement[], tableId: string) =>
  readTable(elements, tableId)!;

describe("setCellFill", () => {
  it("colours only the cells named", () => {
    const { elements, tableId } = grid(2, 2);
    const next = setCellFill(
      elements,
      tableId,
      [{ row: 0, col: 1 }],
      "#ffc9c9",
    );
    const m = model(next, tableId);

    expect(m.cells.get(cellKey(0, 1))!.element.backgroundColor).toBe("#ffc9c9");
    expect(m.cells.get(cellKey(0, 0))!.element.backgroundColor).toBe(
      CELL_BACKGROUND,
    );
  });

  it("colours a whole column when given one", () => {
    const { elements, tableId } = grid(3, 3);
    const column = [0, 1, 2].map((row) => ({ row, col: 2 }));
    const m = model(setCellFill(elements, tableId, column, "#b2f2bb"), tableId);

    for (let row = 0; row < 3; row++) {
      expect(m.cells.get(cellKey(row, 2))!.element.backgroundColor).toBe(
        "#b2f2bb",
      );
      expect(m.cells.get(cellKey(row, 0))!.element.backgroundColor).not.toBe(
        "#b2f2bb",
      );
    }
  });

  it("leaves another table alone", () => {
    const a = grid(1, 1);
    const b = grid(1, 1);
    const all = [...a.elements, ...b.elements];
    const next = setCellFill(all, a.tableId, [{ row: 0, col: 0 }], "#ffc9c9");

    expect(
      model(next, b.tableId).cells.get(cellKey(0, 0))!.element.backgroundColor,
    ).toBe(CELL_BACKGROUND);
  });
});

describe("setHeaderRow", () => {
  it("shades row zero and tags it", () => {
    const { elements, tableId } = grid(2, 2);
    const m = model(
      setHeaderRow(elements, tableId, true, HEADER_BACKGROUND, CELL_BACKGROUND),
      tableId,
    );

    expect(m.cells.get(cellKey(0, 0))!.tag.header).toBe(true);
    expect(m.cells.get(cellKey(0, 0))!.element.backgroundColor).toBe(
      HEADER_BACKGROUND,
    );
    expect(m.cells.get(cellKey(1, 0))!.tag.header).toBe(false);
  });
});

describe("addRow", () => {
  it("appends a row at the end", () => {
    const { elements, tableId } = grid(2, 3);
    const m = model(addRow(elements, tableId, 2), tableId);

    expect(m.rows).toBe(3);
    expect(m.cells.size).toBe(9);
  });

  it("inserts in the middle and pushes the rest down", () => {
    const { elements, tableId } = grid(2, 1, [["top"], ["bottom"]]);
    const m = model(addRow(elements, tableId, 1), tableId);

    expect(m.rows).toBe(3);
    expect(cellText(m.cells.get(cellKey(0, 0)))).toBe("top");
    expect(cellText(m.cells.get(cellKey(1, 0)))).toBe("");
    expect(cellText(m.cells.get(cellKey(2, 0)))).toBe("bottom");
  });

  it("keeps the geometry regular", () => {
    const { elements, tableId } = grid(2, 2);
    const m = model(addRow(elements, tableId, 1), tableId);

    expect(m.cells.get(cellKey(1, 0))!.element.y).toBe(40);
    expect(m.cells.get(cellKey(2, 0))!.element.y).toBe(80);
  });

  it("preserves the ids of rows that survive", () => {
    const { elements, tableId } = grid(2, 1);
    const before = model(elements, tableId).cells.get(cellKey(0, 0))!.element
      .id;
    const after = model(addRow(elements, tableId, 1), tableId).cells.get(
      cellKey(0, 0),
    )!.element.id;

    expect(after).toBe(before);
  });

  it("leaves new cells ungrouped, like the rest of the table", () => {
    // Grouping is deliberately not used: it puts an "enter the group" step in
    // front of every cell, so filling one costs two double-clicks instead of
    // one. Cohesion is the overlay's job (see tableBuild.ts and tableSnap.ts).
    const { elements, tableId } = grid(1, 2);
    const m = model(addRow(elements, tableId, 1), tableId);

    expect(
      [...m.cells.values()].every(
        (c) => (c.element.groupIds ?? []).length === 0,
      ),
    ).toBe(true);
  });

  it("places the new row on the grid the existing rows describe", () => {
    const { elements, tableId } = grid(2, 2);
    const m = model(addRow(elements, tableId, 2), tableId);

    expect(m.cells.get(cellKey(2, 0))!.element.y).toBe(80);
    expect(m.cells.get(cellKey(2, 1))!.element.x).toBe(100);
  });

  it("refuses an out-of-range index", () => {
    const { elements, tableId } = grid(2, 2);
    expect(model(addRow(elements, tableId, 9), tableId).rows).toBe(2);
    expect(model(addRow(elements, tableId, -1), tableId).rows).toBe(2);
  });
});

describe("addColumn", () => {
  it("inserts and shifts the rest right", () => {
    const { elements, tableId } = grid(1, 2, [["left", "right"]]);
    const m = model(addColumn(elements, tableId, 1), tableId);

    expect(m.cols).toBe(3);
    expect(cellText(m.cells.get(cellKey(0, 0)))).toBe("left");
    expect(cellText(m.cells.get(cellKey(0, 2)))).toBe("right");
    expect(m.cells.get(cellKey(0, 2))!.element.x).toBe(200);
  });

  it("adds a cell to every row", () => {
    const { elements, tableId } = grid(3, 1);
    const m = model(addColumn(elements, tableId, 1), tableId);

    expect(m.cells.size).toBe(6);
    for (let row = 0; row < 3; row++) {
      expect(m.cells.get(cellKey(row, 1))).toBeDefined();
    }
  });
});

describe("deleteRow", () => {
  it("removes the row and closes the gap", () => {
    const { elements, tableId } = grid(3, 1, [["a"], ["b"], ["c"]]);
    const next = deleteRow(elements, tableId, 1);
    const m = model(next, tableId);

    expect(m.rows).toBe(2);
    expect(cellText(m.cells.get(cellKey(0, 0)))).toBe("a");
    expect(cellText(m.cells.get(cellKey(1, 0)))).toBe("c");
    expect(m.cells.get(cellKey(1, 0))!.element.y).toBe(40);
  });

  it("marks removed elements deleted rather than dropping them", () => {
    // reconcileElements unions by id and never deletes, so an element that just
    // vanished locally would be reinstated by the next peer to broadcast it.
    const { elements, tableId } = grid(2, 2);
    const next = deleteRow(elements, tableId, 0);

    expect(next.length).toBe(elements.length);
    expect(next.some((el) => el.isDeleted)).toBe(true);
  });

  it("deletes the cell text along with the cell", () => {
    const { elements, tableId } = grid(2, 1, [["gone"], ["stays"]]);
    const next = deleteRow(elements, tableId, 0);
    const survivingText = live(next).filter((el) => el.type === "text");

    expect(survivingText).toHaveLength(1);
    expect((survivingText[0] as { text: string }).text).toBe("stays");
  });

  it("refuses to empty the table", () => {
    const { elements, tableId } = grid(1, 3);
    expect(model(deleteRow(elements, tableId, 0), tableId).rows).toBe(1);
  });
});

describe("deleteColumn", () => {
  it("removes the column and closes the gap", () => {
    const { elements, tableId } = grid(1, 3, [["a", "b", "c"]]);
    const m = model(deleteColumn(elements, tableId, 1), tableId);

    expect(m.cols).toBe(2);
    expect(cellText(m.cells.get(cellKey(0, 0)))).toBe("a");
    expect(cellText(m.cells.get(cellKey(0, 1)))).toBe("c");
    expect(m.cells.get(cellKey(0, 1))!.element.x).toBe(100);
  });

  it("refuses to empty the table", () => {
    const { elements, tableId } = grid(3, 1);
    expect(model(deleteColumn(elements, tableId, 0), tableId).cols).toBe(1);
  });
});

describe("deleteTable", () => {
  it("removes every cell and label, leaving other tables intact", () => {
    const a = grid(2, 2, [
      ["1", "2"],
      ["3", "4"],
    ]);
    const b = grid(1, 1, [["keep"]]);
    const next = deleteTable([...a.elements, ...b.elements], a.tableId);

    expect(readTable(live(next), a.tableId)).toBeNull();
    expect(model(next, b.tableId).cells.size).toBe(1);
  });
});

describe("round trips after editing", () => {
  it("stays a coherent grid through insert, delete and recolour", () => {
    const { elements, tableId } = grid(2, 2, [
      ["a", "b"],
      ["c", "d"],
    ]);

    let next: readonly ExcalidrawElement[] = addRow(elements, tableId, 1);
    next = addColumn(next, tableId, 0);
    next = setCellFill(next, tableId, [{ row: 0, col: 0 }], "#ffc9c9");
    next = deleteRow(next, tableId, 2);

    const m = model(next, tableId);
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(3);
    // every surviving coordinate is occupied — no holes punched by the surgery
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        expect(m.cells.get(cellKey(row, col))).toBeDefined();
      }
    }
    expect(readCellTag(m.cells.get(cellKey(0, 0))!.element)!.tableId).toBe(
      tableId,
    );
  });
});
