import { FONT_FAMILY, getFontString } from "@excalidraw/common";

import type { ExcalidrawTensorElement } from "./types";

/**
 * A tensor block: a labelled rectangle, or an isometric box when it has depth.
 *
 * This is one element. The faces and the dimension labels are derived from
 * `dims` at draw time rather than being separate shapes that happen to sit
 * near each other — so the block moves, rotates, resizes and undoes as the
 * single thing it looks like. The previous version was three polygons and
 * three texts in a group, which is exactly what it should not have been.
 */

/** Isometric foreshortening of the depth axis. */
const ISO_X = 0.55;
const ISO_Y = 0.32;

/** Shortest an edge may draw at, so a lopsided shape stays readable. */
const MIN_EDGE = 26;

const LABEL_FONT_SIZE = 14;
const LABEL_GAP = 6;

/**
 * Room reserved inside the element for the dimension labels.
 *
 * The labels are part of the object, so they have to live inside its bounding
 * box — drawn outside it they are clipped by the element's own canvas, which
 * is what the first version did. Reserving a gutter costs a little drawing
 * area and makes the selection box agree with what you can see.
 */
const LABEL_GUTTER_LEFT = 30;
const LABEL_GUTTER_BOTTOM = LABEL_FONT_SIZE + LABEL_GAP * 2;
const LABEL_GUTTER_RIGHT = 26;

/**
 * On-screen edge lengths for a set of dimensions.
 *
 * Square-root compression rather than linear: a 512x3 tensor drawn to scale is
 * a line, the small axis collapses to nothing and its label has nowhere to sit.
 * The root keeps the ordering — "this axis is much bigger than that one" —
 * which is all a figure needs to say, while keeping every edge visible.
 */
export const edgeLengths = (
  dims: readonly number[],
  longest: number,
): number[] => {
  const roots = dims.map((d) => Math.sqrt(Math.max(1, Math.abs(d))));
  const biggest = Math.max(...roots);
  return roots.map((r) => Math.max(MIN_EDGE, (r / biggest) * longest));
};

export const isVolumetric = (element: ExcalidrawTensorElement) =>
  element.dims.length >= 3;

/**
 * The element's geometry in element-local coordinates.
 *
 * The depth offset is included in the element's own width and height, so the
 * whole block — including the part that leans back and up — sits inside its
 * bounding box. Without that, selecting the element would show a box that does
 * not contain what you can see.
 */
export const tensorGeometry = (element: ExcalidrawTensorElement) => {
  const volumetric = isVolumetric(element);
  const dims = element.dims;

  // Every variant reserves the same gutters, so a 2-D and a 3-D block of the
  // same size have their faces in the same place and swapping between them
  // does not make the drawing jump.
  const availableWidth = Math.max(
    MIN_EDGE,
    element.width - LABEL_GUTTER_LEFT - LABEL_GUTTER_RIGHT,
  );
  const availableHeight = Math.max(
    MIN_EDGE,
    element.height - LABEL_GUTTER_BOTTOM,
  );

  if (!volumetric) {
    return {
      volumetric,
      faceX: LABEL_GUTTER_LEFT,
      faceY: 0,
      faceWidth: availableWidth,
      faceHeight: availableHeight,
      dx: 0,
      dy: 0,
    };
  }

  // dims are [depth, height, width]; the depth lean costs width and height.
  const [d] = edgeLengths(
    [dims[0]!],
    Math.min(availableWidth, availableHeight),
  );
  const dx = d * ISO_X;
  const dy = d * ISO_Y;
  return {
    volumetric,
    faceX: LABEL_GUTTER_LEFT,
    faceY: dy,
    faceWidth: Math.max(MIN_EDGE, availableWidth - dx),
    faceHeight: Math.max(MIN_EDGE, availableHeight - dy),
    dx,
    dy,
  };
};

export const drawTensorOnCanvas = (
  element: ExcalidrawTensorElement,
  context: CanvasRenderingContext2D,
) => {
  const { volumetric, faceX, faceY, faceWidth, faceHeight, dx, dy } =
    tensorGeometry(element);

  context.save();
  context.strokeStyle = element.strokeColor;
  context.lineWidth = element.strokeWidth;

  const fill = element.backgroundColor;
  const shade = (alpha: number, draw: () => void) => {
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = fill;
    context.beginPath();
    draw();
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
    context.restore();
  };

  if (volumetric) {
    // Three faces at one colour and three opacities rather than three chosen
    // hexes: the interactive canvas is filtered in dark mode, and three hand
    // picked colours drift apart under that filter while one at three
    // opacities stays a coherent solid.
    shade(0.55, () => {
      context.moveTo(faceX, faceY);
      context.lineTo(faceX + dx, faceY - dy);
      context.lineTo(faceX + faceWidth + dx, faceY - dy);
      context.lineTo(faceX + faceWidth, faceY);
    });
    shade(0.75, () => {
      context.moveTo(faceX + faceWidth, faceY);
      context.lineTo(faceX + faceWidth + dx, faceY - dy);
      context.lineTo(faceX + faceWidth + dx, faceY + faceHeight - dy);
      context.lineTo(faceX + faceWidth, faceY + faceHeight);
    });
  }

  shade(1, () => {
    context.rect(faceX, faceY, faceWidth, faceHeight);
  });

  // Labels: one per dimension, placed against the edge it measures.
  context.fillStyle = element.strokeColor;
  context.font = getFontString({
    fontSize: LABEL_FONT_SIZE,
    fontFamily: FONT_FAMILY.Cascadia,
  });
  context.textBaseline = "top";

  const label = (
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
  ) => {
    context.save();
    context.textAlign = align;
    context.fillText(text, x, y);
    context.restore();
  };

  if (volumetric) {
    const [depth, height, width] = element.dims;
    label(
      String(width ?? ""),
      faceX + faceWidth / 2,
      faceY + faceHeight + LABEL_GAP,
      "center",
    );
    label(
      String(height ?? ""),
      faceX - LABEL_GAP,
      faceY + faceHeight / 2 - LABEL_FONT_SIZE / 2,
      "right",
    );
    label(
      String(depth ?? ""),
      faceX + faceWidth + dx + LABEL_GAP,
      faceY - dy,
      "left",
    );
  } else {
    const [rows, cols] = element.dims;
    label(
      String(cols ?? ""),
      faceX + faceWidth / 2,
      faceY + faceHeight + LABEL_GAP,
      "center",
    );
    label(
      String(rows ?? ""),
      faceX - LABEL_GAP,
      faceY + faceHeight / 2 - LABEL_FONT_SIZE / 2,
      "right",
    );
  }

  if (element.name) {
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      element.name,
      faceX + faceWidth / 2,
      faceY + faceHeight / 2,
    );
    context.restore();
  }

  context.restore();
};
