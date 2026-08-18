import { FONT_FAMILY, getFontString } from "@excalidraw/common";

import { highlight } from "./codeHighlight";

import type { ExcalidrawCodeElement } from "./types";

/**
 * A syntax-highlighted code block, drawn directly onto the canvas.
 *
 * An Excalidraw text element carries a single `strokeColor`, so coloured code
 * cannot be text — a token would need an element of its own and a twenty-line
 * snippet would become a hundred of them. A renderer holding a raw 2D context
 * has no such limit: it sets `fillStyle` per run and draws.
 *
 * The source is the element's state; the colours are derived from it on every
 * draw. Nothing is cached in the element, so a language change or an edit is
 * simply a different picture from the same data.
 */

/**
 * One dark palette, whatever the board theme is.
 *
 * Code reads as code, contrast is predictable, and a block exported from a
 * dark board matches one exported from a light board — which matters, because
 * the export usually outlives the session. Every colour is at least 4.5:1
 * against `background`, except `comment`, which sits deliberately close to the
 * floor: a comment that competes with the code it explains is the wrong way
 * round.
 */
export const CODE_THEME = {
  background: "#1e2128",
  header: "#171a20",
  border: "#2c313c",
  gutter: "#5c6370",
  text: "#d7dae0",
  languageLabel: "#8b93a1",
  scopes: {
    keyword: "#c678dd",
    built_in: "#56b6c2",
    type: "#e5c07b",
    literal: "#d19a66",
    number: "#d19a66",
    string: "#98c379",
    regexp: "#98c379",
    symbol: "#61afef",
    class: "#e5c07b",
    function: "#61afef",
    title: "#61afef",
    params: "#d7dae0",
    comment: "#7f848e",
    doctag: "#c678dd",
    meta: "#8b93a1",
    "meta-keyword": "#c678dd",
    "meta-string": "#98c379",
    section: "#61afef",
    tag: "#e06c75",
    name: "#e06c75",
    "selector-tag": "#e06c75",
    "selector-id": "#61afef",
    "selector-class": "#e5c07b",
    attr: "#d19a66",
    attribute: "#e5c07b",
    variable: "#e06c75",
    "template-variable": "#e06c75",
    property: "#e06c75",
    operator: "#56b6c2",
    punctuation: "#abb2bf",
    bullet: "#61afef",
    quote: "#7f848e",
    addition: "#98c379",
    deletion: "#e06c75",
    emphasis: "#d7dae0",
    strong: "#d7dae0",
    link: "#61afef",
  } as Record<string, string>,
};

export const CODE_FONT_SIZE = 13;
export const CODE_LINE_HEIGHT = 20;
export const CODE_PAD_X = 14;
export const CODE_PAD_Y = 12;
export const CODE_HEADER_HEIGHT = 30;
const GUTTER_GAP = 12;
const RADIUS = 8;

const codeFont = getFontString({
  fontSize: CODE_FONT_SIZE,
  fontFamily: FONT_FAMILY.Cascadia,
});

/**
 * The colour for a highlight.js scope.
 *
 * Scopes arrive compound — `title.function_` — so the leading segment is the
 * one worth colouring by, and a trailing underscore is highlight.js's own
 * disambiguation marker rather than part of the name.
 */
export const colorForScope = (scope: string | null): string => {
  if (!scope) {
    return CODE_THEME.text;
  }
  const root = scope.split(".")[0]!.replace(/_+$/, "");
  return CODE_THEME.scopes[scope] ?? CODE_THEME.scopes[root] ?? CODE_THEME.text;
};

/**
 * The size a snippet wants to be, for sizing a newly placed element.
 *
 * Measured with the real font rather than an assumed character width, so a
 * block is not systematically too narrow on a machine whose monospace face is
 * wider than the one this was written on.
 */
export const measureCodeBlock = (
  source: string,
  showLineNumbers: boolean,
  context: CanvasRenderingContext2D,
): { width: number; height: number } => {
  const lines = source.split("\n");
  context.save();
  context.font = codeFont;
  const widest = lines.reduce(
    (max, line) => Math.max(max, context.measureText(line).width),
    0,
  );
  const digits = String(Math.max(1, lines.length)).length;
  const gutter = showLineNumbers
    ? context.measureText("0".repeat(digits)).width + GUTTER_GAP
    : 0;
  context.restore();

  return {
    width: Math.ceil(CODE_PAD_X * 2 + gutter + Math.max(widest, 220)),
    height: Math.ceil(
      CODE_HEADER_HEIGHT + CODE_PAD_Y * 2 + lines.length * CODE_LINE_HEIGHT,
    ),
  };
};

const roundedTopPath = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
) => {
  context.beginPath();
  context.moveTo(0, height);
  context.lineTo(0, radius);
  context.quadraticCurveTo(0, 0, radius, 0);
  context.lineTo(width - radius, 0);
  context.quadraticCurveTo(width, 0, width, radius);
  context.lineTo(width, height);
  context.closePath();
};

export const drawCodeOnCanvas = (
  element: ExcalidrawCodeElement,
  context: CanvasRenderingContext2D,
) => {
  const { width, height } = element;
  const highlighted = highlight(element.source, element.language as never);

  context.save();

  // Card
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(0, 0, width, height, RADIUS);
  } else {
    context.rect(0, 0, width, height);
  }
  context.fillStyle = CODE_THEME.background;
  context.fill();
  context.strokeStyle = CODE_THEME.border;
  context.lineWidth = 1;
  context.stroke();

  // Header, clipped to the card's rounded top corners
  context.save();
  roundedTopPath(context, width, CODE_HEADER_HEIGHT, RADIUS);
  context.clip();
  context.fillStyle = CODE_THEME.header;
  context.fillRect(0, 0, width, CODE_HEADER_HEIGHT);
  context.restore();

  context.beginPath();
  context.moveTo(0, CODE_HEADER_HEIGHT);
  context.lineTo(width, CODE_HEADER_HEIGHT);
  context.strokeStyle = CODE_THEME.border;
  context.stroke();

  // The three dots. Decorative, and the one thing that makes a rectangle of
  // coloured text read instantly as "this is code".
  ["#e06c75", "#e5c07b", "#98c379"].forEach((fill, index) => {
    context.beginPath();
    context.arc(14 + index * 14, CODE_HEADER_HEIGHT / 2, 4, 0, Math.PI * 2);
    context.fillStyle = fill;
    context.fill();
  });

  context.font = codeFont;
  context.textBaseline = "top";

  // Language, right-aligned in the header
  context.save();
  context.textAlign = "right";
  context.fillStyle = CODE_THEME.languageLabel;
  context.fillText(
    highlighted.language,
    width - CODE_PAD_X,
    CODE_HEADER_HEIGHT / 2 - CODE_FONT_SIZE / 2,
  );
  context.restore();

  const digits = String(Math.max(1, highlighted.lines.length)).length;
  const gutterWidth = element.showLineNumbers
    ? context.measureText("0".repeat(digits)).width + GUTTER_GAP
    : 0;
  const codeLeft = CODE_PAD_X + gutterWidth;
  const top = CODE_HEADER_HEIGHT + CODE_PAD_Y;

  // Clip the code area so an oversized snippet is cut at the card's edge
  // rather than spilling onto the canvas.
  context.save();
  context.beginPath();
  context.rect(0, CODE_HEADER_HEIGHT, width, height - CODE_HEADER_HEIGHT);
  context.clip();

  highlighted.lines.forEach((runs, index) => {
    const y = top + index * CODE_LINE_HEIGHT;
    if (y > height) {
      return;
    }
    if (element.showLineNumbers) {
      context.save();
      context.textAlign = "right";
      context.fillStyle = CODE_THEME.gutter;
      context.fillText(
        String(index + 1),
        CODE_PAD_X + gutterWidth - GUTTER_GAP,
        y,
      );
      context.restore();
    }
    let x = codeLeft;
    for (const run of runs) {
      context.fillStyle = colorForScope(run.scope);
      context.fillText(run.text, x, y);
      // Advance by the measured width, so a proportional fallback face still
      // lays out contiguously even though the family asks for monospace.
      x += context.measureText(run.text).width;
    }
  });

  context.restore();
  context.restore();
};
