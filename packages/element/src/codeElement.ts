import { FONT_FAMILY, getFontString } from "@excalidraw/common";

import { highlight } from "./codeHighlight";

import type { Drawable, Options } from "roughjs/bin/core";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { RoughGenerator } from "roughjs/bin/generator";

import type { ExcalidrawCodeElement } from "./types";

/**
 * `highlightAuto` scores nineteen grammars and then parses the result with
 * `DOMParser`. Uncached, that ran on every repaint — including every frame of
 * a drag. One entry is enough: a repaint asks for the same source it asked for
 * last time, and a change invalidates it on the next call.
 */
let highlightCache: {
  source: string;
  language: string;
  value: ReturnType<typeof highlight>;
} | null = null;

const highlightMemo = (source: string, language: string) => {
  if (
    highlightCache &&
    highlightCache.source === source &&
    highlightCache.language === language
  ) {
    return highlightCache.value;
  }
  const value = highlight(source, language as never);
  highlightCache = { source, language, value };
  return value;
};

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
/**
 * The gutter's width for a snippet of `lineCount` lines.
 *
 * Shared by the measurer, the renderer and the DOM editor, so the text sits at
 * the same x in all three and does not jump sideways when you start typing.
 */
export const codeGutterWidth = (
  lineCount: number,
  showLineNumbers: boolean,
  context: CanvasRenderingContext2D,
): number => {
  if (!showLineNumbers) {
    return 0;
  }
  const digits = String(Math.max(1, lineCount)).length;
  return context.measureText("0".repeat(digits)).width + GUTTER_GAP;
};

/** The font the canvas and any DOM editor must share. */
export const codeFontString = () => codeFont;

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
  const gutter = codeGutterWidth(lines.length, showLineNumbers, context);
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

/**
 * The roughjs shape for a code block: its card outline.
 *
 * Only the outline. The card's interior is a dark panel with coloured runs of
 * text on it, and hachuring that would make the code unreadable — so the frame
 * is hand-drawn and the content is not, which is the whole point of the
 * chosen direction. `roughness` and `strokeStyle` therefore reach the border,
 * where they are legible, and nothing else.
 */
export const generateCodeShapes = (
  element: ExcalidrawCodeElement,
  generator: RoughGenerator,
  options: Options,
): Drawable[] => [
  generator.rectangle(0, 0, element.width, element.height, {
    ...options,
    fill: undefined,
  }),
];

export const drawCodeOnCanvas = (
  element: ExcalidrawCodeElement,
  context: CanvasRenderingContext2D,
  rc: RoughCanvas,
  shapes: Drawable[],
  _isDarkMode: boolean,
) => {
  const { width, height } = element;
  const highlighted = highlightMemo(element.source, element.language);
  const fontSize = element.fontSize;
  const lineHeight = fontSize * (CODE_LINE_HEIGHT / CODE_FONT_SIZE);
  const padX = CODE_PAD_X * (fontSize / CODE_FONT_SIZE);
  const padY = CODE_PAD_Y * (fontSize / CODE_FONT_SIZE);
  const headerHeight = CODE_HEADER_HEIGHT * (fontSize / CODE_FONT_SIZE);
  const codeFontScaled = getFontString({
    fontSize,
    fontFamily: FONT_FAMILY.Cascadia,
  });

  context.save();

  // The card's own dark fill, drawn crisp beneath the hand-drawn border. A
  // hachured fill here would sit behind the code and destroy its legibility;
  // the palette is fixed for the same reason it always was.
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(0, 0, width, height, RADIUS);
  } else {
    context.rect(0, 0, width, height);
  }
  context.fillStyle = CODE_THEME.background;
  context.fill();

  // The hand-drawn border, over the crisp fill.
  for (const shape of shapes) {
    rc.draw(shape);
  }

  // Header, clipped to the card's rounded top corners
  context.save();
  roundedTopPath(context, width, headerHeight, RADIUS);
  context.clip();
  context.fillStyle = CODE_THEME.header;
  context.fillRect(0, 0, width, headerHeight);
  context.restore();

  context.beginPath();
  context.moveTo(0, headerHeight);
  context.lineTo(width, headerHeight);
  context.strokeStyle = CODE_THEME.border;
  context.lineWidth = 1;
  context.stroke();

  context.font = codeFontScaled;
  context.textBaseline = "top";

  // Language, right-aligned in the header
  context.save();
  context.textAlign = "right";
  context.fillStyle = CODE_THEME.languageLabel;
  context.fillText(
    highlighted.language,
    width - padX,
    headerHeight / 2 - fontSize / 2,
  );
  context.restore();

  const gutterWidth = codeGutterWidth(
    highlighted.lines.length,
    element.showLineNumbers,
    context,
  );
  const codeLeft = padX + gutterWidth;
  const top = headerHeight + padY;

  // Clip the code area so an oversized snippet is cut at the card's edge
  // rather than spilling onto the canvas.
  context.save();
  context.beginPath();
  context.rect(0, headerHeight, width, height - headerHeight);
  context.clip();

  highlighted.lines.forEach((runs, index) => {
    const y = top + index * lineHeight;
    if (y > height) {
      return;
    }
    if (element.showLineNumbers) {
      context.save();
      context.textAlign = "right";
      context.fillStyle = CODE_THEME.gutter;
      context.fillText(String(index + 1), padX + gutterWidth - GUTTER_GAP, y);
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
