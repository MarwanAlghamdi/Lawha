import {
  applyDarkModeFilter,
  FONT_FAMILY,
  getFontString,
  getLineHeight,
  isTransparent,
} from "@excalidraw/common";

import { getLineHeightInPx } from "./textMeasurements";
import { getWrappedTextLines } from "./textWrapping";

import type { Drawable } from "roughjs/bin/core";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { RoughGenerator } from "roughjs/bin/generator";
import type { Options } from "roughjs/bin/core";

import type { ExcalidrawTableElement, FontString, TableCell } from "./types";

/**
 * Geometry and drawing for a table, which is one element owning a whole grid.
 *
 * The grid is stored as fractions — `colWidths` and `rowHeights` each sum to 1
 * — and multiplied by the element's `width`/`height` here, at draw time. Two
 * consequences, and they are the reason for the design:
 *
 *  - the ordinary bounding-box resize scales the table correctly with no
 *    table-specific code anywhere in `resizeElements.ts`, and
 *  - a column drag cannot make cells overlap, because it moves weight between
 *    two neighbours and the total is always 1. The previous composed
 *    implementation had no such invariant and overlapping cells were its most
 *    reported defect.
 */

/** Padding between a cell's edge and its text, in scene units. */
export const CELL_PADDING = 6;

/**
 * Below this cell width, in SCENE units, a column's text is not worth laying
 * out. Named for the units it is compared in: the previous name said "PX" and
 * was compared against a scene-unit width, which is a different number at
 * every zoom.
 */
const MIN_LEGIBLE_WIDTH = 12;

export const DEFAULT_CELL_FONT_SIZE = 16;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Running offsets from a fraction array: [0, f0, f0+f1, ...] scaled by total. */
export const offsets = (
  fractions: readonly number[],
  total: number,
): number[] => {
  const out: number[] = [0];
  let acc = 0;
  for (const fraction of fractions) {
    acc += fraction * total;
    out.push(acc);
  }
  return out;
};

export const columnOffsets = (element: ExcalidrawTableElement) =>
  offsets(element.colWidths, element.width);

export const rowOffsets = (element: ExcalidrawTableElement) =>
  offsets(element.rowHeights, element.height);

/** A cell's box in element-local coordinates. */
export const getCellRect = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
): CellRect => {
  const xs = columnOffsets(element);
  const ys = rowOffsets(element);
  return {
    x: xs[col] ?? 0,
    y: ys[row] ?? 0,
    width: (xs[col + 1] ?? 0) - (xs[col] ?? 0),
    height: (ys[row + 1] ?? 0) - (ys[row] ?? 0),
  };
};

export const getCell = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
): TableCell | null => element.cells[row]?.[col] ?? null;

export const tableRowCount = (element: ExcalidrawTableElement) =>
  element.cells.length;

export const tableColCount = (element: ExcalidrawTableElement) =>
  element.cells[0]?.length ?? 0;

/**
 * Which cell contains a point given in element-local coordinates.
 *
 * Returns null outside the grid. Callers are responsible for un-rotating the
 * pointer first — see `TableElementEditor`.
 */
export const getCellAt = (
  element: ExcalidrawTableElement,
  localX: number,
  localY: number,
): { row: number; col: number } | null => {
  if (
    localX < 0 ||
    localY < 0 ||
    localX > element.width ||
    localY > element.height
  ) {
    return null;
  }
  const xs = columnOffsets(element);
  const ys = rowOffsets(element);

  let col = -1;
  for (let i = 0; i < xs.length - 1; i++) {
    if (localX >= xs[i]! && localX <= xs[i + 1]!) {
      col = i;
      break;
    }
  }
  let row = -1;
  for (let i = 0; i < ys.length - 1; i++) {
    if (localY >= ys[i]! && localY <= ys[i + 1]!) {
      row = i;
      break;
    }
  }
  return row >= 0 && col >= 0 ? { row, col } : null;
};

/**
 * Move weight between two adjacent columns.
 *
 * The two neighbours' fractions are redistributed and everything else is left
 * alone, so the total stays 1 and the table's outer width never changes. Both
 * columns are floored at `minFraction`, which is what stops a drag past the
 * neighbour's edge from inverting it — the failure that produced overlapping
 * cells before.
 */
export const resizeColumn = (
  element: ExcalidrawTableElement,
  index: number,
  deltaFraction: number,
  minFraction = 0.02,
): readonly number[] => {
  const widths = [...element.colWidths];
  const left = widths[index];
  const right = widths[index + 1];
  if (left === undefined || right === undefined) {
    return element.colWidths;
  }
  const clamped = Math.max(
    -(left - minFraction),
    Math.min(right - minFraction, deltaFraction),
  );
  widths[index] = left + clamped;
  widths[index + 1] = right - clamped;
  return widths;
};

export const resizeRow = (
  element: ExcalidrawTableElement,
  index: number,
  deltaFraction: number,
  minFraction = 0.02,
): readonly number[] => {
  const heights = [...element.rowHeights];
  const top = heights[index];
  const bottom = heights[index + 1];
  if (top === undefined || bottom === undefined) {
    return element.rowHeights;
  }
  const clamped = Math.max(
    -(top - minFraction),
    Math.min(bottom - minFraction, deltaFraction),
  );
  heights[index] = top + clamped;
  heights[index + 1] = bottom - clamped;
  return heights;
};

/** Move a whole row to a new index, carrying its contents and its height. */
export const moveRow = (
  element: ExcalidrawTableElement,
  from: number,
  to: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const rows = tableRowCount(element);
  if (from === to || from < 0 || to < 0 || from >= rows || to >= rows) {
    return { cells: element.cells, rowHeights: element.rowHeights };
  }
  const cells = [...element.cells];
  const heights = [...element.rowHeights];
  const [cellRow] = cells.splice(from, 1);
  const [height] = heights.splice(from, 1);
  cells.splice(to, 0, cellRow!);
  heights.splice(to, 0, height!);
  return { cells, rowHeights: heights };
};

export const moveColumn = (
  element: ExcalidrawTableElement,
  from: number,
  to: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  if (from === to || from < 0 || to < 0 || from >= cols || to >= cols) {
    return { cells: element.cells, colWidths: element.colWidths };
  }
  const widths = [...element.colWidths];
  const [width] = widths.splice(from, 1);
  widths.splice(to, 0, width!);

  const cells = element.cells.map((row) => {
    const next = [...row];
    const [cell] = next.splice(from, 1);
    next.splice(to, 0, cell!);
    return next;
  });
  return { cells, colWidths: widths };
};

const emptyCell = (): TableCell => ({ text: "", fill: null, color: null });

/** Insert a row, sharing the new row's height out of the existing ones. */
export const insertRow = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const cols = tableColCount(element);
  const rows = tableRowCount(element);
  const share = 1 / (rows + 1);
  // Existing rows keep their relative proportions and give up `share` between
  // them, so the table's height is unchanged and nothing jumps.
  const heights = element.rowHeights.map((h) => h * (1 - share));
  heights.splice(at, 0, share);

  const cells = [...element.cells];
  cells.splice(at, 0, Array.from({ length: cols }, emptyCell));
  return { cells, rowHeights: heights };
};

export const insertColumn = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  const share = 1 / (cols + 1);
  const widths = element.colWidths.map((w) => w * (1 - share));
  widths.splice(at, 0, share);

  const cells = element.cells.map((row) => {
    const next = [...row];
    next.splice(at, 0, emptyCell());
    return next;
  });
  return { cells, colWidths: widths };
};

/** Remove a row, giving its height back to the survivors proportionally. */
export const deleteRow = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "rowHeights"> => {
  const rows = tableRowCount(element);
  // A table with no rows is not a table; refuse rather than produce one.
  if (rows <= 1) {
    return { cells: element.cells, rowHeights: element.rowHeights };
  }
  const heights = [...element.rowHeights];
  const [removed] = heights.splice(at, 1);
  const remaining = 1 - (removed ?? 0);
  const cells = [...element.cells];
  cells.splice(at, 1);
  return {
    cells,
    rowHeights: heights.map((h) =>
      remaining > 0 ? h / remaining : 1 / heights.length,
    ),
  };
};

export const deleteColumn = (
  element: ExcalidrawTableElement,
  at: number,
): Pick<ExcalidrawTableElement, "cells" | "colWidths"> => {
  const cols = tableColCount(element);
  if (cols <= 1) {
    return { cells: element.cells, colWidths: element.colWidths };
  }
  const widths = [...element.colWidths];
  const [removed] = widths.splice(at, 1);
  const remaining = 1 - (removed ?? 0);
  const cells = element.cells.map((row) => {
    const next = [...row];
    next.splice(at, 1);
    return next;
  });
  return {
    cells,
    colWidths: widths.map((w) =>
      remaining > 0 ? w / remaining : 1 / widths.length,
    ),
  };
};

/** Set one cell's text or fill without disturbing the rest of the grid. */
export const withCell = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
  patch: Partial<TableCell>,
): ExcalidrawTableElement["cells"] =>
  element.cells.map((cells, r) =>
    r === row
      ? cells.map((cell, c) => (c === col ? { ...cell, ...patch } : cell))
      : cells,
  );

/** Extra space outside the grid for matrix brackets, in scene units. */
export const BRACKET_GUTTER = 14;

/** Extra space outside the grid for row/column indices, in scene units. */
export const INDEX_GUTTER = 16;

/**
 * The grid's box inside the element, once brackets and indices have taken
 * their gutters. Everything else here is expressed against this box, so
 * turning an affordance on shrinks the grid rather than letting it overflow.
 */
export const gridLines = (element: ExcalidrawTableElement) => {
  const box = gridBox(element);
  return {
    box,
    xs: offsets(element.colWidths, box.width).map((x) => box.x + x),
    ys: offsets(element.rowHeights, box.height).map((y) => box.y + y),
  };
};

export const gridBox = (element: ExcalidrawTableElement) => {
  const bracket = element.brackets ? BRACKET_GUTTER : 0;
  const index = element.showIndices ? INDEX_GUTTER : 0;
  const left = bracket + index;
  const top = index;
  return {
    x: left,
    y: top,
    width: Math.max(1, element.width - left - bracket),
    height: Math.max(1, element.height - top),
  };
};

const numericCells = (element: ExcalidrawTableElement) =>
  element.cells
    // A header row holds labels, and a label that parses as a number — a
    // column headed `2020` — was both heat-coloured and counted in the range
    // that scales every other cell. It is a label whichever way it reads.
    .filter((_, row) => !(element.headerRow && row === 0))
    .flat()
    .map((cell) => Number(cell.text))
    .filter((n) => Number.isFinite(n));

/**
 * The value range a heatmap scales against, or null when there is not one.
 *
 * Shared so the canvas and SVG renderers cannot disagree about it. They did:
 * the SVG path had its own inlined copy that flattened every cell, so an
 * exported matrix could be shaded differently from the one on screen.
 */
export const heatRange = (
  element: ExcalidrawTableElement,
): { min: number; max: number } | null => {
  if (!element.heatmap) {
    return null;
  }
  const values = numericCells(element);
  return values.length
    ? { min: Math.min(...values), max: Math.max(...values) }
    : null;
};

/**
 * Heatmap colour for a value, low to high.
 *
 * A single hue at varying lightness rather than a red-green ramp: red-green is
 * invisible to the commonest form of colour blindness, and a matrix is read
 * for magnitude, which lightness carries on its own.
 */
export const heatColor = (value: number, min: number, max: number): string => {
  const t = max === min ? 0.5 : (value - min) / (max - min);
  const lightness = Math.round(94 - t * 46);
  return `hsl(217, 82%, ${lightness}%)`;
};

/**
 * Ink that stays legible on a given cell fill.
 *
 * A heatmap varies the cell colour by two orders of magnitude of lightness, so
 * a fixed text colour is illegible at one end of the ramp whichever end you
 * pick: black on the darkest cell in light mode, white on the palest cell in
 * dark mode. Chosen by the fill's own relative luminance, per WCAG, so both
 * ends clear the 4.5:1 bar.
 */
export const inkOn = (fill: string | null, fallback: string): string => {
  if (!fill || isTransparent(fill)) {
    return fallback;
  }
  const rgb = parseColor(fill);
  if (!rgb) {
    return fallback;
  }
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(rgb[0]) +
    0.7152 * channel(rgb[1]) +
    0.0722 * channel(rgb[2]);
  return luminance > 0.45 ? "#1b1b1f" : "#ffffff";
};

/** `#rgb`, `#rrggbb` and `hsl(h, s%, l%)` — everything `cellFill` can emit. */
const parseColor = (color: string): [number, number, number] | null => {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const digits = hex.slice(1);
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((d) => d + d)
            .join("")
        : digits;
    if (full.length < 6) {
      return null;
    }
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgbMatch = hex.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  const hsl = hex.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/i);
  if (!hsl) {
    return null;
  }
  const h = Number(hsl[1]) / 360;
  const sat = Number(hsl[2]) / 100;
  const light = Number(hsl[3]) / 100;
  if (sat === 0) {
    const v = Math.round(light * 255);
    return [v, v, v];
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const toRgb = (t: number) => {
    let x = t;
    if (x < 0) {
      x += 1;
    }
    if (x > 1) {
      x -= 1;
    }
    if (x < 1 / 6) {
      return p + (q - p) * 6 * x;
    }
    if (x < 1 / 2) {
      return q;
    }
    if (x < 2 / 3) {
      return p + (q - p) * (2 / 3 - x) * 6;
    }
    return p;
  };
  return [
    Math.round(toRgb(h + 1 / 3) * 255),
    Math.round(toRgb(h) * 255),
    Math.round(toRgb(h - 1 / 3) * 255),
  ];
};

/** The fill a cell should get, or null for none. */
export const cellFill = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
  range: { min: number; max: number } | null,
): string | null => {
  const cell = getCell(element, row, col);
  if (cell?.fill && !isTransparent(cell.fill)) {
    return cell.fill;
  }
  if (element.heatmap && range) {
    const value = Number(cell?.text);
    if (Number.isFinite(value)) {
      return heatColor(value, range.min, range.max);
    }
  }
  if (
    element.headerRow &&
    row === 0 &&
    !isTransparent(element.backgroundColor)
  ) {
    return element.backgroundColor;
  }
  return null;
};

/**
 * The roughjs shapes for a table: its cell fills, its rules and its border.
 *
 * Generated rather than stroked directly so the table gets everything an
 * ordinary rectangle gets — the hand-drawn line, `roughness`, `strokeStyle`,
 * `fillStyle`, `seed`, and the dark-mode colour transform, all of which live
 * in `generateRoughOptions` and none of which a manual `context.lineTo` sees.
 *
 * All the rules are one `path` rather than one Drawable per line: a single
 * seeded path keeps the wobble coherent across the grid, and it is one draw
 * call instead of `rows + cols + 2`.
 */
export const generateTableShapes = (
  element: ExcalidrawTableElement,
  generator: RoughGenerator,
  options: Options,
  isDarkMode = false,
): Drawable[] => {
  const box = gridBox(element);
  const xs = offsets(element.colWidths, box.width).map((x) => box.x + x);
  const ys = offsets(element.rowHeights, box.height).map((y) => box.y + y);
  const rows = tableRowCount(element);
  const cols = tableColCount(element);
  const shapes: Drawable[] = [];

  const values = element.heatmap ? numericCells(element) : [];
  const range = values.length
    ? { min: Math.min(...values), max: Math.max(...values) }
    : null;

  // Fills first, so the rules sit on top of them rather than being half
  // covered by the next cell's background.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const fill = cellFill(element, row, col, range);
      if (!fill) {
        continue;
      }
      shapes.push(
        generator.rectangle(
          xs[col]!,
          ys[row]!,
          xs[col + 1]! - xs[col]!,
          ys[row + 1]! - ys[row]!,
          // Filtered here, exactly as `generateRoughOptions` filters an
          // element's own `backgroundColor`. `drawTableOnCanvas` reads the
          // same filtered value to choose the cell's ink, so the two cannot
          // disagree about what colour the cell actually is.
          {
            ...options,
            fill: applyDarkModeFilter(fill, isDarkMode),
            stroke: "none",
          },
        ),
      );
    }
  }

  const path: string[] = [];
  // Brackets replace the outer border rather than joining it. A matrix drawn
  // with both is a boxed table with decoration on it; the bracket IS the
  // delimiter, which is why mathematics does not also draw the box.
  const first = element.brackets ? 1 : 0;
  const lastX = element.brackets ? xs.length - 1 : xs.length;
  const lastY = element.brackets ? ys.length - 1 : ys.length;

  for (let i = first; i < lastX; i++) {
    path.push(`M ${xs[i]} ${box.y} L ${xs[i]} ${box.y + box.height}`);
  }
  for (let i = first; i < lastY; i++) {
    path.push(`M ${box.x} ${ys[i]} L ${box.x + box.width} ${ys[i]}`);
  }

  if (element.brackets) {
    const arm = BRACKET_GUTTER * 0.55;
    const l = box.x - BRACKET_GUTTER;
    const r = box.x + box.width + BRACKET_GUTTER;
    const t = box.y;
    const b = box.y + box.height;
    path.push(`M ${l + arm} ${t} L ${l} ${t} L ${l} ${b} L ${l + arm} ${b}`);
    path.push(`M ${r - arm} ${t} L ${r} ${t} L ${r} ${b} L ${r - arm} ${b}`);
  }

  shapes.push(generator.path(path.join(" "), { ...options, fill: undefined }));
  return shapes;
};

/** The family a table's text is set in. Matrices are read as numbers. */
export const cellFontFamily = (element: ExcalidrawTableElement) =>
  element.variant === "matrix" ? FONT_FAMILY.Cascadia : FONT_FAMILY.Excalifont;

/**
 * A cell's font, with weight and style applied.
 *
 * CSS font shorthand orders style before weight before size, so italic has to
 * come first; `getFontString` returns "<size>px <families>", so prefixing is
 * the whole job. One function knows that grammar, rather than the two string
 * substitutions this replaced.
 */
export const cellFont = (
  element: ExcalidrawTableElement,
  bold: boolean,
  italic: boolean,
): FontString => {
  const base = getFontString({
    fontSize: element.fontSize,
    fontFamily: cellFontFamily(element),
  });
  if (!bold && !italic) {
    return base;
  }
  return `${italic ? "italic " : ""}${
    bold ? "bold " : ""
  }${base}` as FontString;
};

/** A cell's text, wrapped and placed. */
export interface ResolvedCellText {
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  font: FontString;
  /** Resolved weight and style, so a caller that cannot read a CSS font
   * shorthand — SVG sets `font-weight` and `font-style` separately — does not
   * have to parse one back out of `font`. */
  bold: boolean;
  italic: boolean;
  /**
   * Where the text hangs from horizontally. What it means depends on `align` —
   * the left edge, the centre, or the right edge. That is exactly the
   * distinction SVG's `text-anchor` draws, so the SVG renderer uses it
   * directly, and a canvas renderer subtracts a measured width from it.
   */
  anchorX: number;
  lines: { text: string; y: number }[];
}

/**
 * Resolve one cell's text: alignment on both axes, weight, style, wrapping and
 * the final position of every line. `null` when there is nothing to draw.
 *
 * ADR 0027. This exists because the alignment maths lived twice — once in
 * `drawTableOnCanvas` and once in `renderTableTextToSvg` — and two axes and
 * four inheritable properties would have made that two copies of something
 * worth getting wrong. 0026 paid for this lesson once already: SVG export
 * emitted a placeholder for all three types because the canvas path was the
 * only one anybody looked at. Neither renderer computes a position now.
 *
 * Note the wrapping uses the RESOLVED font. Wrapping bold text with regular
 * metrics under-wraps it, which is why a bold header could overflow its cell.
 */
export const resolveCellText = (
  element: ExcalidrawTableElement,
  row: number,
  col: number,
  xs: readonly number[],
  ys: readonly number[],
): ResolvedCellText | null => {
  const cell = getCell(element, row, col);
  const text = cell?.text ?? "";
  if (!text) {
    return null;
  }

  const left = xs[col]!;
  const right = xs[col + 1]!;
  const top = ys[row]!;
  const bottom = ys[row + 1]!;
  const maxWidth = right - left - CELL_PADDING * 2;
  // A column dragged very narrow would otherwise spend layout time wrapping
  // text into a sliver nobody can read. Scene units against a scene-unit
  // threshold — the two must not be mixed.
  if (maxWidth < MIN_LEGIBLE_WIDTH) {
    return null;
  }

  const isHeader = element.headerRow && row === 0;
  // `??` and not `||`: false is a real answer for bold, and it has to be able
  // to turn the header row's automatic weight back off.
  const bold = cell?.bold ?? isHeader;
  const italic = cell?.italic ?? false;
  const font = cellFont(element, bold, italic);

  const align = cell?.align ?? element.textAlign;
  // A scene can reach the renderer without passing through `restore`, so the
  // element's own default is defended here too rather than assumed present.
  const verticalAlign = cell?.verticalAlign ?? element.verticalAlign ?? "top";

  const wrapped = getWrappedTextLines(text, font, maxWidth);
  const lineHeightPx = getLineHeightInPx(
    element.fontSize,
    getLineHeight(cellFontFamily(element)),
  );

  const free = bottom - top - wrapped.length * lineHeightPx;
  const offset =
    verticalAlign === "middle"
      ? free / 2
      : verticalAlign === "bottom"
      ? free - CELL_PADDING
      : CELL_PADDING;
  // Never tighter than the cell's own padding: a block taller than its row
  // would otherwise start above the top edge and lose its first line.
  const startY = top + Math.max(CELL_PADDING, offset);

  const anchorX =
    align === "right"
      ? right - CELL_PADDING
      : align === "center"
      ? (left + right) / 2
      : left + CELL_PADDING;

  return {
    align,
    verticalAlign,
    font,
    bold,
    italic,
    anchorX,
    lines: wrapped
      .map((line, index) => ({
        text: line.text,
        y: startY + index * lineHeightPx,
      }))
      .filter((line) => line.y <= bottom),
  };
};

/**
 * Draw the table's text.
 *
 * The container and its rules are roughjs Drawables handed in as `shapes`;
 * everything below is the content, which roughjs cannot express — a cell's
 * text has to land on a baseline, and a matrix's numbers have to be legible at
 * any roughness. `freedraw` already mixes the two the same way.
 *
 * Called from `drawElementOnCanvas` with the context already translated to the
 * element's origin and scaled for zoom and device pixel ratio, so everything
 * here is in element-local units starting at (0, 0).
 */
export const drawTableOnCanvas = (
  element: ExcalidrawTableElement,
  context: CanvasRenderingContext2D,
  rc: RoughCanvas,
  shapes: Drawable[],
  isDarkMode: boolean,
) => {
  for (const shape of shapes) {
    rc.draw(shape);
  }

  const box = gridBox(element);
  const xs = offsets(element.colWidths, box.width).map((x) => box.x + x);
  const ys = offsets(element.rowHeights, box.height).map((y) => box.y + y);
  const rows = tableRowCount(element);
  const cols = tableColCount(element);

  const fontFamily = cellFontFamily(element);
  const fontSize = element.fontSize;
  const font = getFontString({ fontSize, fontFamily });
  const ink = applyDarkModeFilter(element.strokeColor, isDarkMode);
  const range = heatRange(element);

  context.save();
  context.fillStyle = ink;
  context.font = font;
  context.textBaseline = "top";

  if (element.showIndices) {
    context.save();
    context.globalAlpha *= 0.55;
    context.font = getFontString({
      fontSize: fontSize * 0.72,
      fontFamily: FONT_FAMILY.Cascadia,
    });
    context.textAlign = "center";
    for (let col = 0; col < cols; col++) {
      context.fillText(
        String(col),
        (xs[col]! + xs[col + 1]!) / 2,
        box.y - INDEX_GUTTER + 2,
      );
    }
    context.textAlign = "right";
    for (let row = 0; row < rows; row++) {
      context.fillText(
        String(row),
        box.x - (element.brackets ? BRACKET_GUTTER : 0) - 3,
        (ys[row]! + ys[row + 1]!) / 2 - fontSize * 0.36,
      );
    }
    context.restore();
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const resolved = resolveCellText(element, row, col, xs, ys);
      if (!resolved) {
        continue;
      }

      // Clip so an overfull cell is visibly cut off at its own border rather
      // than bleeding into its neighbour and looking like a rendering bug.
      context.save();
      context.beginPath();
      context.rect(
        xs[col]!,
        ys[row]!,
        xs[col + 1]! - xs[col]!,
        ys[row + 1]! - ys[row]!,
      );
      context.clip();

      // An explicit cell colour wins. Otherwise a cell painted by the heatmap
      // picks its own ink so the text stays legible at both ends of the ramp;
      // `applyDarkModeFilter` is applied to the fill first, because that is
      // what the cell will actually be.
      const cell = getCell(element, row, col);
      const fill = cellFill(element, row, col, range);
      context.fillStyle = cell?.color
        ? applyDarkModeFilter(cell.color, isDarkMode)
        : inkOn(fill ? applyDarkModeFilter(fill, isDarkMode) : null, ink);

      context.font = resolved.font;

      resolved.lines.forEach((line) => {
        const width = context.measureText(line.text).width;
        const x =
          resolved.align === "right"
            ? resolved.anchorX - width
            : resolved.align === "center"
            ? resolved.anchorX - width / 2
            : resolved.anchorX;
        context.fillText(line.text, x, line.y);
      });
      context.restore();
    }
  }

  context.restore();
};
