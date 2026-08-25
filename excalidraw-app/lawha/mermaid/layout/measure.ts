/**
 * LAWHA: how big does each node need to be?
 *
 * Everything that decides a size funnels through here, for one reason: sizes
 * must be computed with the SAME text metrics the renderer will draw with, or
 * a label that fits in the layout overflows on the canvas. `measureText` is
 * Excalidraw's own — the one it uses for bound text — so the two agree.
 *
 * In tests `measureText` returns a deterministic 10px per character
 * (`textMeasurements.ts:144`), which is why layout assertions can be exact.
 */

import { getFontString } from "@excalidraw/common";
import { getLineHeight } from "@excalidraw/common";
import { measureText } from "@excalidraw/element";

import type { FontFamilyValues } from "@excalidraw/element/types";

import { CELL_PADDING, TABLE_ROW_HEIGHT } from "../emit/theme";

import type { ConverterOptions } from "../options";
import type { MDiagram, MNode, MSize } from "../model/types";

const FONT_FAMILY_EXCALIFONT = 5 as FontFamilyValues;
const FONT_FAMILY_CASCADIA = 3 as FontFamilyValues;

const measure = (text: string, fontSize: number, family: FontFamilyValues) => {
  const font = getFontString({ fontSize, fontFamily: family });
  return measureText(text || " ", font, getLineHeight(family));
};

const sizeOfLabelNode = (node: MNode, options: ConverterOptions): MSize => {
  const metrics = measure(
    node.label.text,
    options.fontSize,
    FONT_FAMILY_EXCALIFONT,
  );
  let width = metrics.width + options.nodePadding * 2;
  let height = metrics.height + options.nodePadding * 2;

  // A diamond's label sits in the middle third of its bounding box, so a box
  // sized to the text alone clips it. This is the same allowance Excalidraw's
  // own container padding makes.
  if (node.shape === "diamond") {
    width *= 1.6;
    height *= 1.5;
  }

  return {
    width: Math.max(options.minNodeWidth, Math.ceil(width)),
    height: Math.max(options.minNodeHeight, Math.ceil(height)),
  };
};

/**
 * A table's size.
 *
 * Every table we emit is single-column, which is not a simplification but a
 * correctness requirement: `newTableElement` always writes `even(cols)`, so a
 * multi-column table forces every column to the widest one's width, and a
 * column narrower than `MIN_LEGIBLE_WIDTH` drops its text entirely. One column
 * makes `even(1) === [1]` and the whole class of bug unrepresentable.
 */
const sizeOfTableNode = (node: MNode, options: ConverterOptions): MSize => {
  const table = node.table!;
  const rows = [table.header, ...table.rows];
  const widest = rows.reduce((max, row) => {
    const text = row[0]?.text ?? "";
    // Cells are drawn in Cascadia for a matrix and Excalifont for a table;
    // ours are tables. Bold header text is wider, so measure it as bold.
    const metrics = measure(text, options.fontSize, FONT_FAMILY_EXCALIFONT);
    return Math.max(max, metrics.width);
  }, 0);

  return {
    width: Math.max(
      options.minNodeWidth,
      Math.ceil(widest + CELL_PADDING * 2 + 16),
    ),
    height: Math.max(options.minNodeHeight, rows.length * TABLE_ROW_HEIGHT),
  };
};

export const measureDiagram = (
  diagram: MDiagram,
  options: ConverterOptions,
): MDiagram => ({
  ...diagram,
  edges: diagram.edges.map((edge) => {
    if (!edge.label?.text) {
      return edge;
    }
    const metrics = measure(
      edge.label.text,
      options.fontSize,
      FONT_FAMILY_EXCALIFONT,
    );
    return {
      ...edge,
      labelSize: {
        width: Math.ceil(metrics.width) + 8,
        height: Math.ceil(metrics.height) + 4,
      },
    };
  }),
  nodes: diagram.nodes.map((node) => ({
    ...node,
    // A model that already decided its own size keeps it. UML draws a start
    // marker, a fork bar and a choice diamond at a fixed size regardless of
    // what is written near them — measuring their (empty) labels would
    // collapse every one of them to the minimum box.
    size:
      node.size ??
      (node.shape === "table"
        ? sizeOfTableNode(node, options)
        : sizeOfLabelNode(node, options)),
  })),
});

export const __testing = { measure, FONT_FAMILY_CASCADIA };
