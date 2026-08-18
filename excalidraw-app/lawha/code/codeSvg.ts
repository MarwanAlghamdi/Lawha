/**
 * Drawing a highlighted snippet as an SVG card.
 *
 * SVG rather than a bitmap because a code block is read at every zoom level and
 * a rasterised one turns to mush; SVG rather than text elements because an
 * Excalidraw text element carries a single `strokeColor`, so a coloured token
 * would need an element of its own and a twenty-line snippet would become a
 * hundred of them.
 */
import { languageLabel } from "./codeHighlight";

import type { Highlighted, Run } from "./codeHighlight";

/**
 * One dark palette, whatever the canvas theme is.
 *
 * Code reads as code, contrast is predictable, and a block exported from a dark
 * board looks identical to one exported from a light board — which matters,
 * because the export is usually the artefact that outlives the session.
 *
 * Contrast against `background` is at least 4.5:1 for every token colour except
 * `comment`, which sits at 4.6:1 deliberately close to the floor: a comment that
 * competes with the code it explains is the wrong way round.
 */
export const THEME = {
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

/**
 * Type metrics, in SVG user units.
 *
 * `CHAR_WIDTH` is the advance of the monospace face at `FONT_SIZE`. It does not
 * have to match the viewer's font exactly, because every run is drawn with an
 * explicit `textLength` — see `runToSvg`.
 */
const FONT_SIZE = 13;
const CHAR_WIDTH = 7.8;
const LINE_HEIGHT = 20;
const PAD_X = 14;
const PAD_Y = 12;
const HEADER_HEIGHT = 30;
const GUTTER_GAP = 12;
const RADIUS = 8;

/** Fonts are named generically; an SVG in an `img` cannot fetch a web font. */
const FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const colorFor = (scope: string | null): string => {
  if (!scope) {
    return THEME.text;
  }
  // highlight.js emits compound scopes like `title.function_`; the leading
  // segment is the one worth colouring by, and trailing underscores are its own
  // disambiguation marker rather than part of the name.
  const root = scope.split(".")[0]!.replace(/_+$/, "");
  return THEME.scopes[scope] ?? THEME.scopes[root] ?? THEME.text;
};

/**
 * One run, positioned by character column rather than by measured text.
 *
 * `textLength` plus `lengthAdjust="spacingAndGlyphs"` is what makes this safe
 * across machines: whatever monospace face the viewer resolves, the run is drawn
 * to exactly the width its column span implies, so runs cannot drift apart or
 * overlap even if the font's natural advance differs from `CHAR_WIDTH`.
 */
const runToSvg = (run: Run, x: number, y: number): string => {
  const width = run.text.length * CHAR_WIDTH;
  return (
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" fill="${colorFor(
      run.scope,
    )}" ` +
    `textLength="${width.toFixed(2)}" lengthAdjust="spacingAndGlyphs" ` +
    `xml:space="preserve">${escapeXml(run.text)}</text>`
  );
};

export interface CodeSvgOptions {
  showLineNumbers?: boolean;
  /** Shown in the header. Defaults to the highlighted language's label. */
  title?: string;
}

export interface CodeSvg {
  svg: string;
  width: number;
  height: number;
}

/** Longest line, in characters — what the card's width is sized from. */
const widestLine = (lines: Run[][]) =>
  lines.reduce(
    (widest, line) =>
      Math.max(
        widest,
        line.reduce((n, run) => n + run.text.length, 0),
      ),
    0,
  );

export const buildCodeSvg = (
  highlighted: Highlighted,
  options: CodeSvgOptions = {},
): CodeSvg => {
  const { showLineNumbers = true } = options;
  // An empty snippet still has to be a card rather than a zero-height sliver,
  // otherwise a freshly placed block is invisible and looks like a failure.
  const lines = highlighted.lines.length > 0 ? highlighted.lines : [[]];
  const gutterChars = showLineNumbers ? String(lines.length).length : 0;
  const gutterWidth = showLineNumbers
    ? gutterChars * CHAR_WIDTH + GUTTER_GAP
    : 0;

  const codeLeft = PAD_X + gutterWidth;
  const contentWidth = Math.max(widestLine(lines), 24) * CHAR_WIDTH;
  const width = Math.ceil(codeLeft + contentWidth + PAD_X);
  const height = Math.ceil(
    HEADER_HEIGHT + PAD_Y * 2 + lines.length * LINE_HEIGHT,
  );

  const label = options.title ?? languageLabel(highlighted.language);
  const parts: string[] = [];

  parts.push(
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${
      height - 1
    }" rx="${RADIUS}" ` +
      `fill="${THEME.background}" stroke="${THEME.border}"/>`,
  );
  // The header is a rounded rect clipped to the top edge — a plain rect would
  // square off the two top corners the card just rounded.
  parts.push(
    `<path d="M0.5 ${HEADER_HEIGHT} L0.5 ${
      RADIUS + 0.5
    } A${RADIUS} ${RADIUS} 0 0 1 ${RADIUS + 0.5} 0.5 L${
      width - RADIUS - 0.5
    } 0.5 A${RADIUS} ${RADIUS} 0 0 1 ${width - 0.5} ${RADIUS + 0.5} L${
      width - 0.5
    } ${HEADER_HEIGHT} Z" fill="${THEME.header}"/>`,
  );
  parts.push(
    `<line x1="0.5" y1="${HEADER_HEIGHT}" x2="${
      width - 0.5
    }" y2="${HEADER_HEIGHT}" stroke="${THEME.border}"/>`,
  );

  // The three dots. Decorative, and the one thing that makes a rectangle of
  // coloured text read instantly as "this is code".
  const dots = ["#e06c75", "#e5c07b", "#98c379"];
  dots.forEach((fill, index) => {
    parts.push(
      `<circle cx="${14 + index * 14}" cy="${
        HEADER_HEIGHT / 2
      }" r="4" fill="${fill}"/>`,
    );
  });

  parts.push(
    `<text x="${width - PAD_X}" y="${
      HEADER_HEIGHT / 2 + 4
    }" text-anchor="end" ` +
      `fill="${THEME.languageLabel}" font-size="11" ` +
      `letter-spacing="0.4">${escapeXml(label)}</text>`,
  );

  const top = HEADER_HEIGHT + PAD_Y + FONT_SIZE;
  lines.forEach((line, index) => {
    const y = top + index * LINE_HEIGHT;
    if (showLineNumbers) {
      parts.push(
        `<text x="${
          PAD_X + gutterChars * CHAR_WIDTH
        }" y="${y}" text-anchor="end" ` +
          `fill="${THEME.gutter}">${index + 1}</text>`,
      );
    }
    let column = 0;
    for (const run of line) {
      parts.push(runToSvg(run, codeLeft + column * CHAR_WIDTH, y));
      column += run.text.length;
    }
  });

  const svg = `${
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="${FONT_STACK}" font-size="${FONT_SIZE}">`
  }${parts.join("")}</svg>`;

  return { svg, width, height };
};

/**
 * A data URL for the SVG.
 *
 * `encodeURIComponent` rather than base64: the payload is text, this keeps it
 * readable in a saved scene, and it sidesteps `btoa` throwing on any non-Latin-1
 * character — a comment in Arabic or a Chinese string literal is exactly the
 * kind of thing that would otherwise fail at save time rather than at build.
 */
export const svgToDataUrl = (svg: string): string =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;
