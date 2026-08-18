import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { cellKey, readCellTag, readTable } from "../table/tableModel";

import {
  applyHeatmap,
  buildMatrix,
  clearHeatmap,
  identity,
  matrixIdOf,
  mixHex,
  ones,
  readMatrix,
  transposeMatrix,
  zeros,
} from "./matrixOps";
import {
  buildTensor,
  buildTensor2D,
  buildTensor3D,
  parseDims,
} from "./tensorBuild";

const live = (elements: readonly ExcalidrawElement[]) =>
  elements.filter((el) => !el.isDeleted);

describe("value generators", () => {
  it("makes zeros, ones and an identity", () => {
    expect(zeros(2, 3)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(ones(1, 2)).toEqual([[1, 1]]);
    expect(identity(3)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
});

describe("buildMatrix", () => {
  it("tags cells as matrix cells, not table cells", () => {
    const elements = buildMatrix({ x: 0, y: 0, rows: 2, cols: 2 });
    const tags = elements.map(readCellTag).filter(Boolean);

    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag!.kind === "matrix-cell")).toBe(true);
  });

  it("has no header row — a matrix has no column names", () => {
    const elements = buildMatrix({ x: 0, y: 0, rows: 2, cols: 2 });
    const model = readTable(elements, matrixIdOf(elements)!)!;

    expect(model.cells.get(cellKey(0, 0))!.tag.header).toBe(false);
  });

  it("round-trips its values", () => {
    const values = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const elements = buildMatrix({ x: 0, y: 0, rows: 2, cols: 3, values });

    expect(readMatrix(elements, matrixIdOf(elements)!)).toEqual(values);
  });

  it("reads a blank cell as NaN rather than zero", () => {
    // A blank cell and a zero are different claims about the data.
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 1,
      cols: 2,
      values: [[5, NaN]],
    });
    const read = readMatrix(elements, matrixIdOf(elements)!)!;

    expect(read[0][0]).toBe(5);
    expect(Number.isNaN(read[0][1])).toBe(true);
  });
});

describe("mixHex", () => {
  it("interpolates between two colours", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("clamps out-of-range positions", () => {
    expect(mixHex("#000000", "#ffffff", -3)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 9)).toBe("#ffffff");
  });
});

describe("applyHeatmap", () => {
  it("shades the largest and smallest values differently", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 1,
      cols: 3,
      values: [[0, 5, 10]],
    });
    const tableId = matrixIdOf(elements)!;
    const model = readTable(applyHeatmap(elements, tableId), tableId)!;

    const low = model.cells.get(cellKey(0, 0))!.element.backgroundColor;
    const mid = model.cells.get(cellKey(0, 1))!.element.backgroundColor;
    const high = model.cells.get(cellKey(0, 2))!.element.backgroundColor;

    expect(new Set([low, mid, high]).size).toBe(3);
    expect(low).toBe("#ffffff");
  });

  it("does not divide by zero on a flat matrix", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 2,
      cols: 2,
      values: ones(2, 2),
    });
    const tableId = matrixIdOf(elements)!;
    const model = readTable(applyHeatmap(elements, tableId), tableId)!;
    const colours = [...model.cells.values()].map(
      (c) => c.element.backgroundColor,
    );

    expect(new Set(colours).size).toBe(1);
    expect(colours[0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("leaves a blank cell unshaded", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 1,
      cols: 2,
      values: [[3, NaN]],
    });
    const tableId = matrixIdOf(elements)!;
    const model = readTable(applyHeatmap(elements, tableId), tableId)!;

    expect(model.cells.get(cellKey(0, 1))!.element.backgroundColor).toBe(
      "transparent",
    );
  });

  it("can be cleared again", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 1,
      cols: 2,
      values: [[1, 9]],
    });
    const tableId = matrixIdOf(elements)!;
    const shaded = applyHeatmap(elements, tableId);
    const model = readTable(clearHeatmap(shaded, tableId), tableId)!;

    expect(
      [...model.cells.values()].every(
        (c) => c.element.backgroundColor === "transparent",
      ),
    ).toBe(true);
  });
});

describe("transposeMatrix", () => {
  it("flips rows and columns", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 2,
      cols: 3,
      values: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    const tableId = matrixIdOf(elements)!;
    const next = live(transposeMatrix(elements, tableId));

    expect(readMatrix(next, tableId)).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it("marks the old cells deleted rather than dropping them", () => {
    const elements = buildMatrix({
      x: 0,
      y: 0,
      rows: 1,
      cols: 2,
      values: [[1, 2]],
    });
    const next = transposeMatrix(elements, matrixIdOf(elements)!);

    expect(next.some((el) => el.isDeleted)).toBe(true);
  });
});

describe("parseDims", () => {
  it("accepts the ways a shape actually gets written", () => {
    expect(parseDims("3x224x224")).toEqual([3, 224, 224]);
    expect(parseDims("3, 224, 224")).toEqual([3, 224, 224]);
    expect(parseDims("512 768")).toEqual([512, 768]);
    expect(parseDims("")).toEqual([]);
  });

  it("drops zero and junk", () => {
    expect(parseDims("0x5")).toEqual([5]);
    expect(parseDims("batch")).toEqual([]);
  });
});

describe("tensor blocks", () => {
  it("builds a 2-D block with both dimensions labelled", () => {
    const elements = buildTensor2D({ x: 0, y: 0, dims: [512, 768] });
    const texts = elements
      .filter((el) => el.type === "text")
      .map((el) => (el as { text: string }).text);

    expect(texts).toContain("512");
    expect(texts).toContain("768");
  });

  it("builds a 3-D block as three faces plus three labels", () => {
    const elements = buildTensor3D({ x: 0, y: 0, dims: [64, 32, 32] });

    expect(elements.filter((el) => el.type === "line")).toHaveLength(2);
    expect(elements.filter((el) => el.type === "rectangle")).toHaveLength(1);
    expect(
      elements.filter((el) => el.type === "text").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("picks the block from the dimension count", () => {
    expect(
      buildTensor({ x: 0, y: 0, dims: [8, 8] }).some(
        (el) => el.type === "line",
      ),
    ).toBe(false);
    expect(
      buildTensor({ x: 0, y: 0, dims: [8, 8, 8] }).some(
        (el) => el.type === "line",
      ),
    ).toBe(true);
  });

  it("keeps a lopsided shape visible on every axis", () => {
    // Linear scaling would collapse the small axis to nothing and leave its
    // label with nowhere to sit.
    const elements = buildTensor3D({ x: 0, y: 0, dims: [512, 3, 512] });
    const face = elements.find((el) => el.type === "rectangle")!;

    expect(face.height).toBeGreaterThanOrEqual(26);
    expect(face.width).toBeGreaterThan(face.height);
  });

  it("groups the whole block so it drags as one", () => {
    const elements = buildTensor3D({ x: 0, y: 0, dims: [4, 4, 4] });
    const groups = elements
      .filter(
        (el) =>
          el.type !== "text" || !(el as { containerId?: string }).containerId,
      )
      .map((el) => el.groupIds.join(","));

    expect(new Set(groups).size).toBe(1);
  });

  it("survives restore as ordinary shapes", () => {
    const elements = buildTensor3D({
      x: 0,
      y: 0,
      dims: [16, 8, 8],
      name: "conv1",
    });
    const restored = restoreElements(
      JSON.parse(JSON.stringify(elements)),
      null,
    );

    expect(restored.length).toBe(elements.length);
    expect(new Set(restored.map((el) => el.type))).toEqual(
      new Set(["rectangle", "line", "text"]),
    );
  });
});
