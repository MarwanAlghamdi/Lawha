import { pointFrom } from "@excalidraw/math";
import { describe, expect, it } from "vitest";

import type { GlobalPoint } from "@excalidraw/math";

import { newTableElement } from "../src/newElement";
import { resizeColumn } from "../src/tableElement";
import {
  applyAnchorDrop,
  applyDividerDrag,
  dropTargetForAnchor,
  anchorStrip,
  ANCHOR_SIZES,
  getAnchorUnderCursor,
  getCellUnderCursor,
  getPlusUnderCursor,
  plusButtons,
  getDividerUnderCursor,
  nextCell,
  selectedCells,
} from "../src/tableElementEditor";

import type { ExcalidrawTableElement } from "../src/types";

const table = (overrides = {}) =>
  newTableElement({
    x: 100,
    y: 100,
    width: 300,
    height: 120,
    rows: 3,
    cols: 3,
    strokeColor: "#000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    ...overrides,
  }) as ExcalidrawTableElement;

/** getElementAbsoluteCoords only needs the element itself for these. */
const map = new Map() as never;
const at = (x: number, y: number) => pointFrom(x, y) as GlobalPoint;
const sum = (v: readonly number[]) => v.reduce((t, n) => t + n, 0);

describe("finding a cell", () => {
  it("maps a scene point to the cell under it", () => {
    const t = table();
    // element origin is (100,100); columns are 100 wide, rows 40 tall
    expect(getCellUnderCursor(t, map, at(150, 120))).toEqual({
      row: 0,
      col: 0,
    });
    expect(getCellUnderCursor(t, map, at(350, 200))).toEqual({
      row: 2,
      col: 2,
    });
  });

  it("returns null outside the table", () => {
    const t = table();
    expect(getCellUnderCursor(t, map, at(50, 120))).toBeNull();
    expect(getCellUnderCursor(t, map, at(150, 500))).toBeNull();
  });

  it("follows the table when it is rotated", () => {
    // A quarter turn about the centre: the cell that was top-left is now
    // reachable from where the rotation put it. Without un-rotating the
    // pointer, every handle on a rotated table would be in the wrong place.
    const t = table({ angle: Math.PI / 2 });
    const upright = getCellUnderCursor(table(), map, at(150, 120));
    const rotated = getCellUnderCursor(t, map, at(150, 120));

    expect(upright).toEqual({ row: 0, col: 0 });
    expect(rotated).not.toEqual(upright);
  });
});

describe("finding a divider", () => {
  it("finds a column divider at its exact position", () => {
    const t = table();
    // interior dividers sit at x = 100+100 and 100+200
    expect(getDividerUnderCursor(t, map, at(200, 150), 1)).toEqual({
      axis: "col",
      index: 0,
    });
    expect(getDividerUnderCursor(t, map, at(300, 150), 1)).toEqual({
      axis: "col",
      index: 1,
    });
  });

  it("finds a row divider", () => {
    const t = table();
    // x = 250 sits mid-column on purpose: at x = 200 the pointer is also on a
    // column divider, and the column check runs first.
    expect(getDividerUnderCursor(t, map, at(250, 140), 1)).toEqual({
      axis: "row",
      index: 0,
    });
  });

  it("ignores the outer edges, which belong to the bounding box", () => {
    // Two systems fighting over one pixel is how a drag becomes unpredictable.
    const t = table();
    expect(getDividerUnderCursor(t, map, at(100, 150), 1)).toBeNull();
    expect(getDividerUnderCursor(t, map, at(400, 150), 1)).toBeNull();
  });

  it("keeps the same grab size on screen as the zoom changes", () => {
    const t = table();
    // 3 scene units off-centre: within reach at zoom 1, out of reach at zoom 4
    expect(getDividerUnderCursor(t, map, at(203, 150), 1)).not.toBeNull();
    expect(getDividerUnderCursor(t, map, at(203, 150), 4)).toBeNull();
  });

  it("misses when the pointer is nowhere near", () => {
    expect(getDividerUnderCursor(table(), map, at(250, 150), 1)).toBeNull();
  });
});

describe("dragging a divider", () => {
  it("resizes without changing the table's width", () => {
    const t = table();
    const patch = applyDividerDrag(t, { axis: "col", index: 0 }, 30);

    expect(sum(patch.colWidths!)).toBeCloseTo(1, 10);
    expect(patch.colWidths![0]).toBeCloseTo(1 / 3 + 0.1, 6);
    expect(patch.colWidths![1]).toBeCloseTo(1 / 3 - 0.1, 6);
  });

  it("cannot push a column past its neighbour", () => {
    const t = table();
    const patch = applyDividerDrag(t, { axis: "col", index: 0 }, 100000);

    expect(patch.colWidths!.every((w) => w > 0)).toBe(true);
    expect(sum(patch.colWidths!)).toBeCloseTo(1, 10);
  });

  it("resizes rows the same way", () => {
    const patch = applyDividerDrag(table(), { axis: "row", index: 1 }, -20);
    expect(sum(patch.rowHeights!)).toBeCloseTo(1, 10);
  });
});

describe("anchors", () => {
  it("finds a column anchor above the table", () => {
    const t = table();
    expect(getAnchorUnderCursor(t, map, at(150, 92), 1)).toEqual({
      axis: "col",
      index: 0,
    });
  });

  it("finds a row anchor to the left", () => {
    const t = table();
    expect(getAnchorUnderCursor(t, map, at(92, 150), 1)).toEqual({
      axis: "row",
      index: 1,
    });
  });

  it("is not found over the table itself", () => {
    expect(getAnchorUnderCursor(table(), map, at(150, 150), 1)).toBeNull();
  });

  it("picks a drop target from the pointer position", () => {
    const t = table();
    expect(
      dropTargetForAnchor(t, map, { axis: "col", index: 0 }, at(160, 92)),
    ).toBe(0);
    expect(
      dropTargetForAnchor(t, map, { axis: "col", index: 0 }, at(380, 92)),
    ).toBe(2);
  });

  it("reorders a column, carrying its width", () => {
    const t = {
      ...table(),
      colWidths: [0.5, 0.25, 0.25],
    } as ExcalidrawTableElement;
    const patch = applyAnchorDrop(t, { axis: "col", index: 0 }, 2);

    expect(patch.colWidths).toEqual([0.25, 0.25, 0.5]);
    expect(sum(patch.colWidths!)).toBeCloseTo(1, 10);
  });

  it("changes nothing when dropped where it started", () => {
    expect(applyAnchorDrop(table(), { axis: "row", index: 1 }, 1)).toEqual({});
  });
});

describe("bulk selection", () => {
  it("expands a column selection to every cell in it", () => {
    const cells = selectedCells(table(), { axis: "col", indices: [1] });
    expect(cells).toHaveLength(3);
    expect(cells.every((c) => c.col === 1)).toBe(true);
  });

  it("expands a row selection", () => {
    const cells = selectedCells(table(), { axis: "row", indices: [0, 2] });
    expect(cells).toHaveLength(6);
  });

  it("is empty with no selection", () => {
    expect(selectedCells(table(), null)).toEqual([]);
  });
});

describe("keyboard navigation", () => {
  it("moves with the arrows and stops at the edge", () => {
    const t = table();
    expect(nextCell(t, { row: 1, col: 1 }, "ArrowUp")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextCell(t, { row: 0, col: 1 }, "ArrowUp")).toEqual({
      row: 0,
      col: 1,
    });
    expect(nextCell(t, { row: 1, col: 2 }, "ArrowRight")).toEqual({
      row: 1,
      col: 2,
    });
  });

  it("wraps to the next row on Tab, like a spreadsheet", () => {
    const t = table();
    expect(nextCell(t, { row: 0, col: 2 }, "Tab")).toEqual({ row: 1, col: 0 });
    expect(nextCell(t, { row: 1, col: 0 }, "ShiftTab")).toEqual({
      row: 0,
      col: 2,
    });
  });

  it("stops at the last cell rather than falling off", () => {
    const t = table();
    expect(nextCell(t, { row: 2, col: 2 }, "Tab")).toEqual({ row: 2, col: 2 });
    expect(nextCell(t, { row: 0, col: 0 }, "ShiftTab")).toEqual({
      row: 0,
      col: 0,
    });
  });
});

describe("the resize invariant, end to end", () => {
  it("never lets a column reach zero however hard it is dragged", () => {
    // The whole reason for the rewrite, stated as a property.
    let widths = table().colWidths;
    for (const delta of [0.4, 0.4, 0.4, -0.9, 0.9, -0.4]) {
      const t = { ...table(), colWidths: widths } as ExcalidrawTableElement;
      widths = resizeColumn(t, 0, delta);
      expect(widths.every((w) => w > 0)).toBe(true);
      expect(sum(widths)).toBeCloseTo(1, 10);
    }
  });
});

describe("anchor geometry", () => {
  /**
   * These pin the defect that made the anchors unusable: the strip started at
   * `DEFAULT_TRANSFORM_HANDLE_SPACING` — the very offset the transform handles
   * are placed at — so the corner handles were drawn on top of the first and
   * last anchors, and on touch a 12px anchor sat beside a 28px handle.
   */
  it("clears the band the selection border and transform handles occupy", () => {
    const t = table();
    const strip = anchorStrip(t, "col", 1, 1, "mouse")!;
    // `renderSelectionBorder` draws at DEFAULT_TRANSFORM_HANDLE_SPACING * 2 = 4
    // outside the element; the strip must start beyond that.
    expect(strip.y + strip.height).toBeLessThanOrEqual(-4);
  });

  it("insets the first and last anchors clear of the corner handles", () => {
    const t = table();
    const first = anchorStrip(t, "col", 0, 1, "mouse")!;
    const middle = anchorStrip(t, "col", 1, 1, "mouse")!;
    expect(first.x).toBeGreaterThan(0);
    // the middle anchor needs no inset — nothing collides with it
    expect(middle.x).toBe(100);
  });

  it("sizes the target by pointer type, as transform handles do", () => {
    const t = table();
    const mouse = anchorStrip(t, "col", 1, 1, "mouse")!;
    const touch = anchorStrip(t, "col", 1, 1, "touch")!;
    expect(touch.height).toBe(ANCHOR_SIZES.touch);
    expect(touch.height).toBeGreaterThan(mouse.height);
  });

  it("keeps a constant on-screen size at any zoom", () => {
    const t = table();
    const at1 = anchorStrip(t, "col", 1, 1, "mouse")!;
    const at4 = anchorStrip(t, "col", 1, 4, "mouse")!;
    expect(at4.height * 4).toBeCloseTo(at1.height, 10);
  });

  it("drops an anchor for a column too narrow to be a target", () => {
    const t = table({ cols: 3 });
    // Middle columns carry no corner inset, so this isolates the width floor:
    // 1% of a 300-wide table is 3px, below half a 10px mouse target.
    const squeezed = { ...t, colWidths: [0.9, 0.01, 0.09] } as typeof t;
    expect(anchorStrip(squeezed, "col", 1, 1, "mouse")).toBeNull();

    // 8% is 24px — comfortably a target, and it keeps its anchor.
    const roomy = { ...t, colWidths: [0.9, 0.08, 0.02] } as typeof t;
    expect(anchorStrip(roomy, "col", 1, 1, "mouse")).not.toBeNull();
  });

  it("hit-tests against the geometry it draws", () => {
    const t = table();
    const strip = anchorStrip(t, "col", 1, 1, "mouse")!;
    const centre = at(
      t.x + strip.x + strip.width / 2,
      t.y + strip.y + strip.height / 2,
    );
    expect(getAnchorUnderCursor(t, map, centre, 1)).toEqual({
      axis: "col",
      index: 1,
    });
  });
});

describe("add-row and add-column buttons", () => {
  it("sits at the trailing edge of each axis", () => {
    const t = table();
    const [addCol, addRow] = plusButtons(t, 1, "mouse");
    expect(addCol!.axis).toBe("col");
    expect(addCol!.x).toBeGreaterThan(t.width - 1);
    expect(addRow!.axis).toBe("row");
    expect(addRow!.y).toBeGreaterThan(t.height - 1);
  });

  it("is hit-testable where it is drawn", () => {
    const t = table();
    const [addCol] = plusButtons(t, 1, "mouse");
    const centre = at(
      t.x + addCol!.x + addCol!.width / 2,
      t.y + addCol!.y + addCol!.height / 2,
    );
    expect(getPlusUnderCursor(t, map, centre, 1)).toBe("col");
  });

  it("does not claim a pixel inside the grid", () => {
    const t = table();
    expect(getPlusUnderCursor(t, map, at(t.x + 50, t.y + 50), 1)).toBeNull();
  });
});
