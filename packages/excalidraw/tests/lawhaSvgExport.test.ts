import {
  newCodeElement,
  newTableElement,
  newTensorElement,
} from "@excalidraw/element";

import { getDefaultAppState } from "../appState";
import { exportToSvg } from "../scene/export";

/**
 * LAWHA: these three types had no `case` in `staticSvgScene.ts`, so they fell
 * into the unknown-type branch and exported as a dashed grey placeholder — the
 * branch that exists for types a build cannot draw, which this build plainly
 * can. It was invisible on canvas, because PNG export goes through the canvas
 * renderer instead. These tests exist so it stays fixed.
 */

const exportOne = async (element: any) => {
  const svg = await exportToSvg(
    [element],
    { ...getDefaultAppState(), exportBackground: false },
    null,
  );
  return svg.outerHTML;
};

const PLACEHOLDER = "868e96";

describe("lawha SVG export", () => {
  it("exports a table as real geometry, not the unknown-type placeholder", async () => {
    const html = await exportOne(
      newTableElement({
        x: 0,
        y: 0,
        width: 300,
        height: 150,
        cells: [
          [
            { text: "Method", fill: null, color: null },
            { text: "Acc", fill: null, color: null },
          ],
        ],
        rows: 1,
        cols: 2,
      }),
    );

    expect(html).not.toContain(PLACEHOLDER);
    expect(html).toContain("Method");
    expect(html).toContain("Acc");
  });

  it("exports a matrix's numbers", async () => {
    const html = await exportOne(
      newTableElement({
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        variant: "matrix",
        cells: [
          [
            { text: "1", fill: null, color: null },
            { text: "0", fill: null, color: null },
          ],
          [
            { text: "0", fill: null, color: null },
            { text: "1", fill: null, color: null },
          ],
        ],
        rows: 2,
        cols: 2,
      }),
    );

    expect(html).not.toContain(PLACEHOLDER);
    // right-aligned, as a matrix is read
    expect(html).toContain('text-anchor="end"');
  });

  it("exports a tensor's dimension labels", async () => {
    const html = await exportOne(
      newTensorElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        dims: [64, 32, 16],
      }),
    );

    expect(html).not.toContain(PLACEHOLDER);
    expect(html).toContain(">64<");
    expect(html).toContain(">32<");
    expect(html).toContain(">16<");
  });

  it("exports a code block's source, coloured", async () => {
    const html = await exportOne(
      newCodeElement({
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        source: "def greet():\n    pass",
        language: "python",
      }),
    );

    expect(html).not.toContain(PLACEHOLDER);
    expect(html).toContain("greet");
    // the card's own dark panel, not a transparent rect
    expect(html).toContain(CODE_BACKGROUND);
  });

  /**
   * ADR 0027. The canvas and SVG renderers now share `resolveCellText`, and
   * the reason they must is the defect this file was written for: alignment
   * lived in two places and only one of them was ever looked at. A per-cell
   * property that works on screen and not in an export is the same bug.
   */
  it("carries per-cell alignment, weight and style into the SVG", async () => {
    const html = await exportOne(
      newTableElement({
        x: 0,
        y: 0,
        width: 300,
        height: 120,
        // The element default is left; the cells override it individually,
        // which is the whole point of 0027.
        textAlign: "left",
        headerRow: false,
        cells: [
          [
            { text: "LeftCell", fill: null, color: null },
            {
              text: "RightCell",
              fill: null,
              color: null,
              align: "right" as const,
            },
          ],
          [
            {
              text: "BoldCell",
              fill: null,
              color: null,
              bold: true,
            },
            {
              text: "ItalicCell",
              fill: null,
              color: null,
              italic: true,
            },
          ],
        ],
        rows: 2,
        cols: 2,
      }),
    );

    expect(html).not.toContain(PLACEHOLDER);
    // Every cell's text is present...
    for (const text of ["LeftCell", "RightCell", "BoldCell", "ItalicCell"]) {
      expect(html).toContain(text);
    }
    // ...and the overrides actually reached the output.
    expect(html).toContain('text-anchor="end"');
    expect(html).toContain('font-weight="bold"');
    expect(html).toContain('font-style="italic"');
  });

  it("does not bold or italicise a plain table", async () => {
    const html = await exportOne(
      newTableElement({
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        headerRow: false,
        cells: [
          [
            { text: "plain", fill: null, color: null },
            { text: "cells", fill: null, color: null },
          ],
        ],
        rows: 1,
        cols: 2,
      }),
    );

    expect(html).toContain("plain");
    expect(html).not.toContain('font-weight="bold"');
    expect(html).not.toContain('font-style="italic"');
  });
});

const CODE_BACKGROUND = "#1e2128";
