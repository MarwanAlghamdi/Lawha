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
});

const CODE_BACKGROUND = "#1e2128";
