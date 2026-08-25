import {
  applyDarkModeFilter,
  FONT_FAMILY,
  getFontFamilyString,
  getFontString,
  THEME,
} from "@excalidraw/common";
import {
  CODE_FONT_SIZE,
  CODE_HEADER_HEIGHT,
  CODE_LINE_HEIGHT,
  CODE_PAD_X,
  CODE_PAD_Y,
  CODE_THEME,
  codeFontString,
  codeGutterWidth,
  colorForScope,
  cellFill,
  cellFontFamily,
  getCell,
  heatRange,
  inkOn,
  resolveCellText,
  gridLines,
  highlight,
  tensorGeometry,
  TENSOR_FACE_ALPHAS,
  tableColCount,
  tableRowCount,
} from "@excalidraw/element";

import type {
  ExcalidrawCodeElement,
  ExcalidrawTableElement,
  ExcalidrawTensorElement,
} from "@excalidraw/element/types";

import type { AppState } from "../types";

/** Only the theme is needed; both render configs carry it. */
type ThemedConfig = { theme: AppState["theme"] };

/**
 * LAWHA: SVG export for tables, tensors and code blocks.
 *
 * Without this these types have no `case` in `staticSvgScene.ts` and fall into
 * the unknown-type branch, exporting as a dashed grey placeholder — the branch
 * that exists for types a build does not recognise, which this build plainly
 * does. PNG export was unaffected because it goes through the canvas renderer.
 *
 * The roughjs container is emitted by the caller from the same cached shape
 * the canvas uses. Everything here is the text on top of it, which is the same
 * split `drawTableOnCanvas` makes.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** A measuring context, so SVG text lays out exactly as the canvas does. */
let measuringContext: CanvasRenderingContext2D | null = null;
const measurer = (): CanvasRenderingContext2D | null => {
  if (!measuringContext) {
    measuringContext = document.createElement("canvas").getContext("2d");
  }
  return measuringContext;
};

const svgText = (
  doc: Document,
  text: string,
  x: number,
  y: number,
  opts: {
    fill: string;
    fontFamily: string;
    fontSize: number;
    anchor?: string;
    weight?: string;
    /** `italic`. Separate from `weight` because CSS keeps the axes separate. */
    fontStyle?: string;
    opacity?: number;
  },
) => {
  const node = doc.createElementNS(SVG_NS, "text");
  node.textContent = text;
  node.setAttribute("x", `${x}`);
  node.setAttribute("y", `${y}`);
  node.setAttribute("font-family", opts.fontFamily);
  node.setAttribute("font-size", `${opts.fontSize}px`);
  node.setAttribute("fill", opts.fill);
  node.setAttribute("text-anchor", opts.anchor ?? "start");
  node.setAttribute("style", "white-space: pre;");
  node.setAttribute("dominant-baseline", "hanging");
  if (opts.weight) {
    node.setAttribute("font-weight", opts.weight);
  }
  if (opts.fontStyle) {
    node.setAttribute("font-style", opts.fontStyle);
  }
  if (opts.opacity !== undefined) {
    node.setAttribute("fill-opacity", `${opts.opacity}`);
  }
  return node;
};

export const renderTableTextToSvg = (
  element: ExcalidrawTableElement,
  node: SVGElement,
  renderConfig: ThemedConfig,
) => {
  const doc = node.ownerDocument!;
  const { box, xs, ys } = gridLines(element);
  const rows = tableRowCount(element);
  const cols = tableColCount(element);
  const fontFamily = cellFontFamily(element);
  const fontSize = element.fontSize;
  const family = getFontFamilyString({ fontFamily });
  const isDark = renderConfig.theme === THEME.DARK;
  const fill = applyDarkModeFilter(element.strokeColor, isDark);
  // Shared with the canvas renderer. This used to be an inlined copy that
  // flattened every cell, so an exported matrix could be shaded on a different
  // range from the one on screen — and after ADR 0027's header-row exclusion
  // the two would have disagreed outright.
  const range = heatRange(element);

  if (element.showIndices) {
    for (let col = 0; col < cols; col++) {
      node.appendChild(
        svgText(doc, String(col), (xs[col]! + xs[col + 1]!) / 2, box.y - 14, {
          fill,
          fontFamily: getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia }),
          fontSize: fontSize * 0.72,
          anchor: "middle",
          opacity: 0.55,
        }),
      );
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const resolved = resolveCellText(element, row, col, xs, ys);
      if (!resolved) {
        continue;
      }
      const cell = getCell(element, row, col);
      const cellFillColor = cellFill(element, row, col, range);
      const ink = cell?.color
        ? applyDarkModeFilter(cell.color, isDark)
        : inkOn(
            cellFillColor ? applyDarkModeFilter(cellFillColor, isDark) : null,
            fill,
          );

      // `anchorX` carries the same distinction `text-anchor` does, so the SVG
      // path needs no arithmetic of its own — which is the point of resolving
      // it once for both renderers.
      const anchor =
        resolved.align === "right"
          ? "end"
          : resolved.align === "center"
          ? "middle"
          : "start";
      resolved.lines.forEach((line) => {
        node.appendChild(
          svgText(doc, line.text, resolved.anchorX, line.y, {
            fill: ink,
            fontFamily: family,
            fontSize,
            anchor,
            weight: resolved.bold ? "bold" : undefined,
            fontStyle: resolved.italic ? "italic" : undefined,
          }),
        );
      });
    }
  }
};

export const renderTensorTextToSvg = (
  element: ExcalidrawTensorElement,
  node: SVGElement,
  renderConfig: ThemedConfig,
) => {
  const doc = node.ownerDocument!;
  const { volumetric, faceX, faceY, faceWidth, faceHeight, dx, dy } =
    tensorGeometry(element);
  const fontSize = element.fontSize;
  const family = getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia });
  const fill = applyDarkModeFilter(
    element.strokeColor,
    renderConfig.theme === THEME.DARK,
  );
  const gap = 6;
  const put = (text: string, x: number, y: number, anchor: string) =>
    node.appendChild(
      svgText(doc, text, x, y, { fill, fontFamily: family, fontSize, anchor }),
    );

  if (volumetric) {
    const [depth, height, width] = element.dims;
    put(
      String(width ?? ""),
      faceX + faceWidth / 2,
      faceY + faceHeight + gap,
      "middle",
    );
    put(
      String(height ?? ""),
      faceX - gap,
      faceY + faceHeight / 2 - fontSize / 2,
      "end",
    );
    put(String(depth ?? ""), faceX + faceWidth + dx + gap, faceY - dy, "start");
  } else {
    const [rows, cols] = element.dims;
    put(
      String(cols ?? ""),
      faceX + faceWidth / 2,
      faceY + faceHeight + gap,
      "middle",
    );
    put(
      String(rows ?? ""),
      faceX - gap,
      faceY + faceHeight / 2 - fontSize / 2,
      "end",
    );
  }

  if (element.name) {
    put(
      element.name,
      faceX + faceWidth / 2,
      faceY + faceHeight / 2 - fontSize / 2,
      "middle",
    );
  }
};

/**
 * A code block's whole interior: the dark card, its header and the coloured
 * runs. Unlike the other two this does NOT reuse the roughjs shape for its
 * fill — the card is a solid panel behind text, as it is on canvas.
 */
export const renderCodeToSvg = (
  element: ExcalidrawCodeElement,
  node: SVGElement,
) => {
  const doc = node.ownerDocument!;
  const { width, height } = element;
  const highlighted = highlight(element.source, element.language as never);
  const fontSize = element.fontSize;
  const scale = fontSize / CODE_FONT_SIZE;
  const lineHeight = CODE_LINE_HEIGHT * scale;
  const padX = CODE_PAD_X * scale;
  const padY = CODE_PAD_Y * scale;
  const headerHeight = CODE_HEADER_HEIGHT * scale;
  const family = getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia });

  const rect = (x: number, y: number, w: number, h: number, fill: string) => {
    const r = doc.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", `${x}`);
    r.setAttribute("y", `${y}`);
    r.setAttribute("width", `${w}`);
    r.setAttribute("height", `${h}`);
    r.setAttribute("fill", fill);
    r.setAttribute("rx", "8");
    return r;
  };

  node.appendChild(rect(0, 0, width, height, CODE_THEME.background));
  node.appendChild(rect(0, 0, width, headerHeight, CODE_THEME.header));
  node.appendChild(
    svgText(
      doc,
      highlighted.language,
      width - padX,
      headerHeight / 2 - fontSize / 2,
      {
        fill: CODE_THEME.languageLabel,
        fontFamily: family,
        fontSize,
        anchor: "end",
      },
    ),
  );

  const context = measurer();
  if (context) {
    context.font = codeFontString();
  }
  const gutterWidth = context
    ? codeGutterWidth(
        highlighted.lines.length,
        element.showLineNumbers,
        context,
      )
    : 0;
  const codeLeft = padX + gutterWidth * scale;
  const top = headerHeight + padY;

  highlighted.lines.forEach((runs, index) => {
    const y = top + index * lineHeight;
    if (y > height) {
      return;
    }
    if (element.showLineNumbers) {
      node.appendChild(
        svgText(doc, String(index + 1), padX + gutterWidth * scale - 12, y, {
          fill: CODE_THEME.gutter,
          fontFamily: family,
          fontSize,
          anchor: "end",
        }),
      );
    }
    let x = codeLeft;
    for (const run of runs) {
      node.appendChild(
        svgText(doc, run.text, x, y, {
          fill: colorForScope(run.scope),
          fontFamily: family,
          fontSize,
        }),
      );
      if (context) {
        context.font = getFontString({
          fontSize,
          fontFamily: FONT_FAMILY.Cascadia,
        });
        x += context.measureText(run.text).width;
      } else {
        x += run.text.length * fontSize * 0.6;
      }
    }
  });
};

export const TENSOR_SVG_FACE_ALPHAS = TENSOR_FACE_ALPHAS;
