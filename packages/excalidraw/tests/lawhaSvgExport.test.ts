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

  it("exports every axis of a four-dimensional tensor", async () => {
    const html = await exportOne(
      newTensorElement({
        x: 0,
        y: 0,
        width: 280,
        height: 200,
        dims: [8, 64, 32, 16],
      }),
    );

    // The pinned 3-D case above stayed green through the whole period in which
    // a 4-D tensor lost its last axis, because every tensor fixture in this
    // repo was 3-D. The batch dimension is written as a multiplier and the
    // trailing three go on the faces.
    expect(html).not.toContain(PLACEHOLDER);
    expect(html).toContain(">8 ×<");
    expect(html).toContain(">64<");
    expect(html).toContain(">32<");
    expect(html).toContain(">16<");
  });

  it("exports a one-dimensional tensor with no empty label beside it", async () => {
    const html = await exportOne(
      newTensorElement({
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        dims: [512],
      }),
    );

    expect(html).toContain(">512<");
    // The missing second axis used to be drawn as an empty string at a real
    // coordinate, which reaches the file as a `<text>` node with no content.
    expect(html).not.toContain("></text>");
  });

  it("fades a stacked tensor's ghosts in the export, as the canvas does", async () => {
    const html = await exportOne(
      newTensorElement({
        x: 0,
        y: 0,
        width: 280,
        height: 200,
        dims: [8, 64, 32, 16],
      }),
    );

    // Nine shapes: three faces per box, three boxes. The alpha arithmetic this
    // replaced handled a count of 1 or 3 only, so everything behind the front
    // box exported fully opaque while the screen showed it faded.
    expect(html).toContain('fill-opacity="0.3"');
    expect(html).toContain('fill-opacity="0.55"');
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
