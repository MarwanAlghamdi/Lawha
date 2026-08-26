import {
  applyDarkModeFilter,
  FONT_FAMILY,
  getFontString,
} from "@excalidraw/common";

import type { Drawable, Options } from "roughjs/bin/core";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { RoughGenerator } from "roughjs/bin/generator";

import type { ExcalidrawTensorElement } from "./types";

/**
 * A tensor block: a labelled rectangle, an isometric box, or a stack of them.
 *
 * This is one element. The faces and the dimension labels are derived from
 * `dims` at draw time rather than being separate shapes that happen to sit
 * near each other — so the block moves, rotates, resizes and undoes as the
 * single thing it looks like. The previous version was three polygons and
 * three texts in a group, which is exactly what it should not have been.
 *
 * ## How `dims` is read
 *
 * `dims` is `readonly number[]` and always has been; what changed (ADR 0030)
 * is that the *drawing* now reads all of it. Every rank has its own layout:
 *
 * | rank | read as                                | drawn as                       |
 * | ---- | -------------------------------------- | ------------------------------ |
 * | 1    | `[n]`                                  | a rectangle, one label         |
 * | 2    | `[rows, cols]`                         | a flat rectangle               |
 * | 3    | `[depth, height, width]`               | an isometric box               |
 * | ≥4   | `[...lead, depth, height, width]`      | that box, as a receding stack  |
 *
 * The rank-≥4 case is the one worth explaining. `[8, 64, 32, 32]` — a batch of
 * feature maps, which is most of what anyone draws a tensor for — used to lose
 * its last number entirely: the code destructured exactly three entries, so the
 * batch dimension was drawn as the depth axis and the trailing 32 vanished with
 * no diagnostic. A viewer had no way to tell it apart from `[8, 64, 32]`.
 *
 * The stack is a **symbol for repetition, not a count**. Two ghost copies are
 * drawn whether the leading dims multiply out to 8 or to 8,192, and the numbers
 * are carried by the label above them. That is the same reasoning as the
 * square-root compression below: a figure has to say "this is repeated, this
 * many times", and it cannot say it by drawing 8,192 of anything.
 */

/** Isometric foreshortening of the depth axis. */
const ISO_X = 0.55;
const ISO_Y = 0.32;

/** Shortest an edge may draw at, so a lopsided shape stays readable. */
const MIN_EDGE = 26;

export const TENSOR_LABEL_FONT_SIZE = 14;
const LABEL_FONT_SIZE = TENSOR_LABEL_FONT_SIZE;
const LABEL_GAP = 6;

/**
 * Room reserved inside the element for the dimension labels.
 *
 * The labels are part of the object, so they have to live inside its bounding
 * box — drawn outside it they are clipped by the element's own canvas, which
 * is what the first version did. Reserving a gutter costs a little drawing
 * area and makes the selection box agree with what you can see.
 *
 * Stated at `TENSOR_LABEL_FONT_SIZE` and **scaled by the element's actual
 * `fontSize`** in `tensorGeometry`. They used to be flat pixel counts while the
 * labels drew at `element.fontSize`, which `transform.ts` and `restore.ts` both
 * accept at any positive value — so a 40px label drew into a 26px gutter and
 * out through the side of the element. At the default size the scale factor is
 * exactly 1, so nothing about the shipped drawing moves.
 */
const LABEL_GUTTER_LEFT = 30;
const LABEL_GUTTER_BOTTOM = LABEL_FONT_SIZE + LABEL_GAP * 2;
const LABEL_GUTTER_RIGHT = 26;

/**
 * How many ghost copies stand behind the front box at rank ≥ 4.
 *
 * Two. Not derived from the leading dims, and that is the decision: a stack
 * whose depth tracked the batch size would be one box at `[1, …]` — which is
 * not a stack and would read as rank 3 — and an unreadable smear at `[512, …]`.
 * Two says "repeated" at every size, and the multiplier label says how often.
 */
export const STACK_LAYERS = 2;

/**
 * Width of one Cascadia glyph as a fraction of the font size.
 *
 * A ratio rather than a measurement: `tensorGeometry` runs on every frame of a
 * resize and on the export path, where there is no 2D context to measure with.
 * Cascadia Mono is monospaced, so one number describes every digit exactly, and
 * 0.6 is that number for this face — the same figure `lawhaSvg.ts` already
 * falls back to when it cannot measure. Rounded up slightly, because a gutter
 * that is a pixel too wide costs a pixel and one that is a pixel too narrow
 * clips a digit.
 */
const CHAR_WIDTH = 0.62;

/**
 * Offset per ghost, along the same isometric axis the box already leans on.
 *
 * A fraction of the drawing area rather than a pixel count, with a floor. The
 * first version used a flat 9px, which on a 300px block left a sliver of ghost
 * peeking out from behind an opaque front face — the stack read as a smudge on
 * one edge rather than as depth. The offset has to scale with the box because
 * what it competes against is the box.
 */
const STACK_STEP_RATIO = 0.09;
const STACK_STEP_MIN = 10;

/**
 * On-screen edge lengths for a set of dimensions.
 *
 * Square-root compression rather than linear: a 512x3 tensor drawn to scale is
 * a line, the small axis collapses to nothing and its label has nowhere to sit.
 * The root keeps the ordering — "this axis is much bigger than that one" —
 * which is all a figure needs to say, while keeping every edge visible.
 *
 * **Give it every axis you are comparing.** Called with a one-element array it
 * is arithmetically a no-op: `biggest` is that element's own root, so the ratio
 * is 1 and the result is `longest` whatever the input was. `tensorGeometry`
 * used to do exactly that for the depth lean, which meant `[2, 64, 32]` and
 * `[512, 64, 32]` drew a pixel-identical box while this docstring sat above
 * explaining the compression that was not happening.
 */
export const edgeLengths = (
  dims: readonly number[],
  longest: number,
): number[] => {
  const roots = dims.map((d) => Math.sqrt(Math.max(1, Math.abs(d))));
  const biggest = Math.max(...roots);
  return roots.map((r) => Math.max(MIN_EDGE, (r / biggest) * longest));
};

/**
 * How this element's `dims` splits into a drawable core and a repeat count.
 *
 * One place answers "what rank is this and which numbers go on the faces",
 * because four call sites used to answer it independently by destructuring
 * three entries and hoping.
 */
export interface TensorLayout {
  rank: number;
  /** The leading axes, which become the stack multiplier. Empty below rank 4. */
  lead: readonly number[];
  /** At most the trailing three axes — what the faces are drawn from. */
  core: readonly number[];
  /** Whether the core is drawn as a box rather than flat. */
  volumetric: boolean;
  /** Whether ghost copies stand behind it. */
  stacked: boolean;
}

export const tensorLayout = (
  element: ExcalidrawTensorElement,
): TensorLayout => {
  const dims = element.dims;
  const rank = dims.length;
  const core = rank > 3 ? dims.slice(-3) : dims;
  const lead = rank > 3 ? dims.slice(0, rank - 3) : [];

  return {
    rank,
    lead,
    core,
    volumetric: core.length >= 3,
    stacked: lead.length > 0,
  };
};

export const isVolumetric = (element: ExcalidrawTensorElement) =>
  tensorLayout(element).volumetric;

/**
 * The element's geometry in element-local coordinates.
 *
 * The depth offset and the stack lean are included in the element's own width
 * and height, so the whole block — including the parts that lean back and up —
 * sits inside its bounding box. Without that, selecting the element would show
 * a box that does not contain what you can see, and the export crop would cut
 * off the labels that canvas happens to paint into its offscreen padding.
 */
export const tensorGeometry = (element: ExcalidrawTensorElement) => {
  const { core, volumetric, stacked } = tensorLayout(element);

  // Every gutter is stated at the default font size and scaled by the real
  // one. See LABEL_GUTTER_LEFT: the labels have always drawn at
  // `element.fontSize`, so constants left them free to overflow.
  const scale = element.fontSize / TENSOR_LABEL_FONT_SIZE;
  const gap = LABEL_GAP * scale;
  const layers = stacked ? STACK_LAYERS : 0;

  // Wide enough for the number that goes in it, never narrower than the
  // constant. The gutters used to be fixed while the labels are as wide as
  // their digits, so a three-digit depth on a 3-D block already drew past
  // `element.x + element.width` — into the offscreen padding, which canvas
  // paints and `getElementAbsoluteCoords`, hit testing and the export crop all
  // exclude. The SVG `<g>` is unclipped and drew it anyway, so the two
  // renderers disagreed in that band without either of them failing.
  const room = (value: number | undefined) =>
    gap + String(value ?? "").length * element.fontSize * CHAR_WIDTH;

  const gutterLeft = Math.max(
    LABEL_GUTTER_LEFT * scale,
    room(volumetric ? core[1] : core[core.length - 2]),
  );
  const gutterRight = Math.max(
    LABEL_GUTTER_RIGHT * scale,
    volumetric ? room(core[0]) : 0,
  );

  // The multiplier ("8 × 4 ×") sits above the stack, so it costs height only
  // when there is a stack to sit above.
  const gutterTop = stacked ? element.fontSize + gap : 0;

  // Every variant reserves the same gutters, so a 2-D and a 3-D block of the
  // same size have their faces in the same place and swapping between them
  // does not make the drawing jump. The stack allowance is on top of that,
  // because a stack genuinely occupies room the flat block does not.
  //
  // Solved before the step is known and then re-solved with it: the step is a
  // fraction of the drawing area, and the drawing area is what is left after
  // the step. One pass with a provisional area is close enough — the ratio is
  // small, and the second solve only ever shrinks the area, so nothing escapes.
  const widthBefore = element.width - gutterLeft - gutterRight;
  const heightBefore = element.height - LABEL_GUTTER_BOTTOM * scale - gutterTop;
  const step = stacked
    ? Math.max(
        STACK_STEP_MIN * scale,
        Math.min(widthBefore, heightBefore) * STACK_STEP_RATIO,
      )
    : 0;
  const stepX = step;
  // Equal parts, not the isometric ratio. Following ISO_Y/ISO_X put each ghost
  // only 0.58 of a step above the one in front, and since the front box is
  // opaque all that separated the layers was a few pixels of top edge — the
  // stack read as one box with lines ruled across it. The lean of the *box* is
  // isometric because it is depth; the offset of the *stack* is repetition,
  // which is not the same axis and does not have to share its foreshortening.
  const stepY = step;
  const stackX = stepX * layers;
  const stackY = stepY * layers;

  const availableWidth = Math.max(MIN_EDGE, widthBefore - stackX);
  const availableHeight = Math.max(MIN_EDGE, heightBefore - stackY);

  const faceX = gutterLeft;

  if (!volumetric) {
    return {
      volumetric,
      stacked,
      layers,
      gap,
      stepX,
      stepY,
      faceX,
      faceY: gutterTop,
      faceWidth: availableWidth,
      faceHeight: availableHeight,
      dx: 0,
      dy: 0,
    };
  }

  // `core` is [depth, height, width]; the depth lean costs width and height.
  //
  // All three axes go to `edgeLengths`, not just the depth. Passing one axis
  // made the ratio 1 by construction, so the lean was the same size for every
  // tensor ever drawn — see the note on `edgeLengths`.
  const [d] = edgeLengths(core, Math.min(availableWidth, availableHeight));
  const dx = d * ISO_X;
  const dy = d * ISO_Y;
  return {
    volumetric,
    stacked,
    layers,
    gap,
    stepX,
    stepY,
    faceX,
    faceY: gutterTop + dy + stackY,
    faceWidth: Math.max(MIN_EDGE, availableWidth - dx),
    faceHeight: Math.max(MIN_EDGE, availableHeight - dy),
    dx,
    dy,
  };
};

/**
 * Per-face opacity within one box, front-most last.
 *
 * Three faces at one colour and three opacities rather than three chosen
 * hexes: the static canvas transforms colours for dark mode, and three hand
 * picked colours drift apart under that transform while one at three
 * opacities stays a coherent solid.
 */
export const TENSOR_FACE_ALPHAS = [0.55, 0.75, 1] as const;

/** How much of its colour a ghost keeps, back-most first. */
const STACK_LAYER_ALPHAS = [0.3, 0.55] as const;

/**
 * The roughjs shapes for a tensor: its faces, back to front.
 *
 * A polygon per face rather than a hand-stroked path, so the block gets the
 * hand-drawn edge, `roughness`, `strokeStyle`, `fillStyle` and the dark-mode
 * colour transform that every other shape on the canvas gets.
 *
 * At rank ≥ 4 the same box is emitted once per stack layer, furthest first, so
 * painting them in order lays the front box over its ghosts.
 */
export const generateTensorShapes = (
  element: ExcalidrawTensorElement,
  generator: RoughGenerator,
  options: Options,
): Drawable[] => {
  const {
    volumetric,
    layers,
    stepX,
    stepY,
    faceX,
    faceY,
    faceWidth,
    faceHeight,
    dx,
    dy,
  } = tensorGeometry(element);
  const shapes: Drawable[] = [];

  const box = (offsetX: number, offsetY: number) => {
    const x = faceX + offsetX;
    const y = faceY + offsetY;

    if (volumetric) {
      shapes.push(
        generator.polygon(
          [
            [x, y],
            [x + dx, y - dy],
            [x + faceWidth + dx, y - dy],
            [x + faceWidth, y],
          ],
          options,
        ),
      );
      shapes.push(
        generator.polygon(
          [
            [x + faceWidth, y],
            [x + faceWidth + dx, y - dy],
            [x + faceWidth + dx, y + faceHeight - dy],
            [x + faceWidth, y + faceHeight],
          ],
          options,
        ),
      );
    }

    shapes.push(generator.rectangle(x, y, faceWidth, faceHeight, options));
  };

  // Furthest ghost first. `layers` is 0 below rank 4, so this loop emits
  // exactly the one box every existing tensor has always drawn.
  for (let layer = layers; layer >= 1; layer--) {
    box(stepX * layer, -stepY * layer);
  }
  box(0, 0);

  return shapes;
};

/**
 * One alpha per shape from `generateTensorShapes`, in the same order.
 *
 * Derived from the element rather than indexed off the array, because the
 * arithmetic that used to do this — `shapes.length - TENSOR_FACE_ALPHAS.length`
 * — only ever worked for a shape count of exactly 1 or 3. A stack emits three
 * per layer, and under the old expression every shape but the last three fell
 * through to full opacity, in **two files** that had to be edited together.
 * Both now ask this function instead.
 */
export const tensorShapeAlphas = (
  element: ExcalidrawTensorElement,
): number[] => {
  const { volumetric, layers } = tensorGeometry(element);
  const faces = volumetric ? TENSOR_FACE_ALPHAS : ([1] as const);
  const alphas: number[] = [];

  for (let layer = layers; layer >= 1; layer--) {
    // Index from the back: layer `layers` is furthest away and faintest.
    const depth = STACK_LAYER_ALPHAS[layers - layer] ?? STACK_LAYER_ALPHAS[0]!;
    alphas.push(...faces.map((face) => face * depth));
  }
  alphas.push(...faces);

  return alphas;
};

/** Where one piece of a tensor's text goes, in element-local coordinates. */
export interface TensorLabel {
  text: string;
  x: number;
  y: number;
  /** Horizontal anchor, spelled the way SVG spells it. */
  align: "start" | "middle" | "end";
  /** `top` hangs the text below `y`; `middle` centres it on `y`. */
  baseline: "top" | "middle";
}

/**
 * Every piece of text a tensor draws, and where.
 *
 * **The single source for both renderers.** The canvas and the SVG exporter
 * used to carry this layout twice, line for line — same `?? ""` fallbacks,
 * same three anchor formulas, differing only in whether an anchor was called
 * `right` or `end` — with the geometry shared through `tensorGeometry` and the
 * labels not. That is the mechanism by which an export drifts from the screen:
 * nothing fails, the two files simply stop agreeing, and only somebody
 * comparing a PNG to a canvas would ever find out.
 */
export const resolveTensorLabels = (
  element: ExcalidrawTensorElement,
): TensorLabel[] => {
  const { core, lead, rank, volumetric, stacked } = tensorLayout(element);
  const {
    gap,
    faceX,
    faceY,
    faceWidth,
    faceHeight,
    dx,
    dy,
    layers,
    stepX,
    stepY,
  } = tensorGeometry(element);
  const labels: TensorLabel[] = [];

  const put = (
    value: number | string | undefined,
    x: number,
    y: number,
    align: TensorLabel["align"],
    baseline: TensorLabel["baseline"] = "top",
  ) => {
    // Nothing rather than an empty `fillText` at a real coordinate. A rank-1
    // tensor used to emit one of those for the column it does not have.
    if (value === undefined || value === "") {
      return;
    }
    labels.push({ text: String(value), x, y, align, baseline });
  };

  if (volumetric) {
    const [depth, height, width] = core;
    put(width, faceX + faceWidth / 2, faceY + faceHeight + gap, "middle");
    put(
      height,
      faceX - gap,
      faceY + faceHeight / 2 - element.fontSize / 2,
      "end",
    );
    // Off the BACK-MOST ghost's top-right corner, not the front box's. The
    // stack extends past the front box in exactly these two directions, so a
    // label anchored to the front box is a label written on top of the ghosts.
    put(
      depth,
      faceX + faceWidth + dx + stepX * layers + gap,
      faceY - dy - stepY * layers,
      "start",
    );
  } else if (rank === 1) {
    // One axis, one label, centred under the shape. The old code destructured
    // `[rows, cols]` here and drew the missing `cols` as an empty string.
    put(core[0], faceX + faceWidth / 2, faceY + faceHeight + gap, "middle");
  } else {
    const [rows, cols] = core;
    put(cols, faceX + faceWidth / 2, faceY + faceHeight + gap, "middle");
    put(
      rows,
      faceX - gap,
      faceY + faceHeight / 2 - element.fontSize / 2,
      "end",
    );
  }

  if (stacked) {
    // Above the back-most ghost's top-left corner, which is the only part of
    // the stack nothing else is written against. Reads left to right as
    // "8 × 4 × [this box]", which is how the shape is spoken.
    put(
      `${lead.join(" × ")} ×`,
      faceX + stepX * layers,
      Math.max(0, faceY - dy - stepY * layers - element.fontSize - gap),
      "start",
    );
  }

  if (element.name) {
    put(
      element.name,
      faceX + faceWidth / 2,
      faceY + faceHeight / 2,
      "middle",
      "middle",
    );
  }

  return labels;
};

/**
 * Draw the tensor's faces and its dimension labels.
 *
 * The faces are roughjs Drawables handed in as `shapes`; the labels are text
 * and have to land on a baseline, so they are drawn here.
 */
export const drawTensorOnCanvas = (
  element: ExcalidrawTensorElement,
  context: CanvasRenderingContext2D,
  rc: RoughCanvas,
  shapes: Drawable[],
  isDarkMode: boolean,
) => {
  // Alphas are applied MULTIPLICATIVELY against whatever the caller set:
  // `drawElementOnCanvas` is handed a context whose globalAlpha is already the
  // element's own opacity, and assigning an absolute value would ignore it.
  const alphas = tensorShapeAlphas(element);
  const base = context.globalAlpha;
  shapes.forEach((shape, index) => {
    context.globalAlpha = base * (alphas[index] ?? 1);
    rc.draw(shape);
  });
  context.globalAlpha = base;

  context.save();
  context.fillStyle = applyDarkModeFilter(element.strokeColor, isDarkMode);
  context.font = getFontString({
    fontSize: element.fontSize,
    fontFamily: FONT_FAMILY.Cascadia,
  });

  for (const label of resolveTensorLabels(element)) {
    context.save();
    context.textAlign =
      label.align === "middle"
        ? "center"
        : label.align === "end"
        ? "right"
        : "left";
    context.textBaseline = label.baseline === "middle" ? "middle" : "top";
    context.fillText(label.text, label.x, label.y);
    context.restore();
  }

  context.restore();
};

/**
 * The most axes a tensor will keep.
 *
 * Not a rendering limit — the drawing is the same at rank 4 and rank 40, since
 * the stack is a symbol and the leading axes are a label. It is a limit on that
 * label: rank 40 writes thirty-seven numbers across the top of the block, which
 * is not a diagram of anything. Eight is comfortably past the deepest shape
 * anyone works with.
 */
export const MAX_RANK = 8;

/**
 * Parse a shape written the way a shape is written: `64x32x32`,
 * `64, 32, 32`, `64 × 32 × 32`.
 *
 * Anything that is not a positive number is dropped rather than turned into a
 * zero-sized face — a typo should cost you a digit, not the block.
 */
/**
 * A caller-supplied shape, or null when there is nothing usable in it.
 *
 * The programmatic twin of `parseDims`: same predicate, same rank bound, for
 * dims that arrive as an array rather than as typed text. Null rather than a
 * default, so the one caller decides what "nothing usable" means — a new
 * element falls back to a shape, a mid-edit draft keeps the one it had.
 */
export const sanitizeDims = (
  dims: readonly number[] | undefined,
): number[] | null => {
  if (!dims?.length) {
    return null;
  }
  const kept = dims
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .slice(0, MAX_RANK);
  return kept.length ? kept : null;
};

export const parseDims = (input: string): number[] =>
  input
    .split(/[^0-9.]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_RANK);
