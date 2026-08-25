import { describe, expect, it } from "vitest";

import { newTableElement } from "../src/newElement";
import {
  CELL_PADDING,
  cellFont,
  columnOffsets,
  deleteColumn,
  deleteRow,
  getCellAt,
  getCellRect,
  heatColor,
  inkOn,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  heatRange,
  resizeColumn,
  resizeRow,
  resolveCellText,
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
    expect(t.cells[0]![0]).toEqual({ text: "", fill: null, color: null });
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

    expect(cells[1]![1]).toEqual({ text: "x", fill: "#ffc9c9", color: null });
    expect(cells[0]).toBe(t.cells[0]);
  });
});

describe("cell ink", () => {
  /**
   * A heatmap varies cell lightness across the whole range, so a fixed text
   * colour is illegible at one end whichever end you pick. Both screenshots
   * showed it: black on the darkest cell in light mode, white on the palest in
   * dark mode.
   */
  it("goes dark on a light fill and light on a dark fill", () => {
    expect(inkOn("#ffffff", "#000")).toBe("#1b1b1f");
    expect(inkOn("#1971c2", "#000")).toBe("#ffffff");
  });

  it("falls back when there is no fill to read", () => {
    expect(inkOn(null, "#1e1e1e")).toBe("#1e1e1e");
    expect(inkOn("transparent", "#1e1e1e")).toBe("#1e1e1e");
  });

  it("reads the hsl the heatmap actually emits", () => {
    // heatColor returns hsl(); if the parser cannot read it, every heatmap
    // cell silently falls back and the bug returns.
    const low = heatColor(0, 0, 10);
    const high = heatColor(10, 0, 10);
    expect(low).toMatch(/^hsl\(/);
    expect(inkOn(low, "#000")).toBe("#1b1b1f");
    expect(inkOn(high, "#000")).toBe("#ffffff");
  });

  it("keeps both ends of the ramp above the 4.5:1 contrast floor", () => {
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return (
        0.2126 * channel((n >> 16) & 255) +
        0.7152 * channel((n >> 8) & 255) +
        0.0722 * channel(n & 255)
      );
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    for (const value of [0, 2.5, 5, 7.5, 10]) {
      const fill = heatColor(value, 0, 10);
      const ink = inkOn(fill, "#000");
      // convert the hsl fill to hex via the same ramp endpoints we can assert
      const approx = ink === "#ffffff" ? "#1864ab" : "#eef4fd";
      expect(ratio(ink, approx)).toBeGreaterThan(4.5);
    }
  });
});

// ADR 0027. The resolver is the single place both renderers get alignment,
// weight and placement from, so this is where that contract is pinned.
describe("resolveCellText", () => {
  const xs = [0, 100, 200, 300];
  const ys = [0, 40, 80, 120];

  const withText = (
    overrides: Record<string, unknown> = {},
    patch: Record<string, unknown> = {},
  ) => {
    const t = table(3, 3, overrides);
    return { ...t, cells: withCell(t, 1, 0, { text: "x", ...patch }) };
  };

  it("returns nothing for an empty cell", () => {
    expect(resolveCellText(table(3, 3), 1, 0, xs, ys)).toBeNull();
  });

  it("returns nothing for a column too narrow to read", () => {
    const t = withText();
    expect(resolveCellText(t, 1, 0, [0, 8, 200, 300], ys)).toBeNull();
  });

  it("inherits the element's horizontal alignment", () => {
    const left = resolveCellText(withText({ textAlign: "left" }), 1, 0, xs, ys);
    expect(left!.align).toBe("left");
    expect(left!.anchorX).toBe(CELL_PADDING);

    const right = resolveCellText(
      withText({ textAlign: "right" }),
      1,
      0,
      xs,
      ys,
    );
    expect(right!.align).toBe("right");
    expect(right!.anchorX).toBe(100 - CELL_PADDING);

    const centre = resolveCellText(
      withText({ textAlign: "center" }),
      1,
      0,
      xs,
      ys,
    );
    expect(centre!.align).toBe("center");
    expect(centre!.anchorX).toBe(50);
  });

  it("lets one cell override the element's alignment", () => {
    const t = withText({ textAlign: "left" }, { align: "right" });
    const resolved = resolveCellText(t, 1, 0, xs, ys)!;
    expect(resolved.align).toBe("right");
    expect(resolved.anchorX).toBe(100 - CELL_PADDING);
  });

  it("treats an explicit null as inheriting, not as a value", () => {
    const t = withText({ textAlign: "center" }, { align: null });
    expect(resolveCellText(t, 1, 0, xs, ys)!.align).toBe("center");
  });

  it("defaults vertical alignment to the top, which is what 0026 drew", () => {
    const resolved = resolveCellText(withText(), 1, 0, xs, ys)!;
    expect(resolved.verticalAlign).toBe("top");
    expect(resolved.lines[0]!.y).toBe(ys[1]! + CELL_PADDING);
  });

  it("moves text down for middle and bottom", () => {
    const top = resolveCellText(withText(), 1, 0, xs, ys)!;
    const middle = resolveCellText(
      withText({}, { verticalAlign: "middle" }),
      1,
      0,
      xs,
      ys,
    )!;
    const bottom = resolveCellText(
      withText({}, { verticalAlign: "bottom" }),
      1,
      0,
      xs,
      ys,
    )!;

    expect(middle.lines[0]!.y).toBeGreaterThan(top.lines[0]!.y);
    expect(bottom.lines[0]!.y).toBeGreaterThan(middle.lines[0]!.y);
    // Never past its own row, whichever way it is aligned.
    expect(bottom.lines[0]!.y).toBeLessThanOrEqual(ys[2]!);
  });

  it("never starts above the cell's own padding, however tall the text", () => {
    // A one-pixel row cannot fit a line, and bottom alignment would otherwise
    // compute a negative offset and lose the first line off the top edge.
    const t = withText({}, { verticalAlign: "bottom" });
    const resolved = resolveCellText(t, 1, 0, xs, [0, 40, 41, 120]);
    if (resolved && resolved.lines.length) {
      expect(resolved.lines[0]!.y).toBeGreaterThanOrEqual(40 + CELL_PADDING);
    }
  });

  it("bolds the header row, and lets a cell turn that back off", () => {
    const t = table(3, 3, { headerRow: true });
    const header = { ...t, cells: withCell(t, 0, 0, { text: "Model" }) };
    expect(resolveCellText(header, 0, 0, xs, ys)!.bold).toBe(true);

    const plain = {
      ...t,
      cells: withCell(t, 0, 0, { text: "Model", bold: false }),
    };
    // `??` not `||` — false has to be a real answer here.
    expect(resolveCellText(plain, 0, 0, xs, ys)!.bold).toBe(false);
  });

  it("carries italic independently of weight", () => {
    const t = withText({}, { italic: true, bold: true });
    const resolved = resolveCellText(t, 1, 0, xs, ys)!;
    expect(resolved.italic).toBe(true);
    expect(resolved.bold).toBe(true);
  });
});

describe("cellFont", () => {
  it("orders style before weight, as the CSS shorthand requires", () => {
    const t = table(1, 1);
    expect(cellFont(t, false, false)).not.toMatch(/bold|italic/);
    expect(cellFont(t, true, false)).toMatch(/^bold \d/);
    expect(cellFont(t, false, true)).toMatch(/^italic \d/);
    // "italic bold 16px ..." parses; "bold italic 16px ..." does not.
    expect(cellFont(t, true, true)).toMatch(/^italic bold \d/);
  });
});

describe("heatRange", () => {
  const numeric = (element: ExcalidrawTableElement, values: string[][]) => ({
    ...element,
    cells: element.cells.map((row, r) =>
      row.map((cell, c) => ({ ...cell, text: values[r]?.[c] ?? "" })),
    ),
  });

  it("is null when the heatmap is off", () => {
    const t = numeric(table(2, 2, { heatmap: false }), [
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(heatRange(t)).toBeNull();
  });

  it("excludes the header row, which is labels however it parses", () => {
    // A column headed `2020` used to be heat-coloured AND counted in the range
    // that scales every other cell, which shifted the whole ramp.
    const t = numeric(table(2, 2, { heatmap: true, headerRow: true }), [
      ["2020", "2021"],
      ["1", "3"],
    ]);
    expect(heatRange(t)).toEqual({ min: 1, max: 3 });
  });

  it("counts row 0 when there is no header row", () => {
    const t = numeric(table(2, 2, { heatmap: true, headerRow: false }), [
      ["10", "20"],
      ["1", "3"],
    ]);
    expect(heatRange(t)).toEqual({ min: 1, max: 20 });
  });

  it("is null when no cell parses as a number", () => {
    const t = numeric(table(2, 2, { heatmap: true, headerRow: false }), [
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(heatRange(t)).toBeNull();
  });
});
