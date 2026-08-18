/**
 * Tensor blocks — the annotated shapes used to draw a model architecture.
 *
 * A 2-D block is a rectangle carrying its shape as a label on each axis; a 3-D
 * block is the same idea drawn isometrically, the way a conv feature map is
 * drawn in a paper figure. Both are composed from rectangles, closed lines and
 * text — nothing here is a new element type (ADR 0023).
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { randomId } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { LAWHA_KEY } from "../table/tableModel";

export interface TensorSpec {
  x: number;
  y: number;
  /** `[rows, cols]` for a 2-D block, `[depth, height, width]` for a 3-D one. */
  dims: number[];
  /** Optional name shown inside the block, e.g. "conv1". */
  name?: string;
  /** Longest on-screen edge, in scene units. The other edges scale from dims. */
  size?: number;
  backgroundColor?: string;
}

const DEFAULT_SIZE = 120;
const MIN_EDGE = 26;
/** Isometric foreshortening for the depth axis. */
const ISO_X = 0.55;
const ISO_Y = 0.32;

const tensorTag = (tensorId: string, dims: number[], role: string) => ({
  [LAWHA_KEY]: {
    kind: "tensor" as const,
    tableId: tensorId,
    row: 0,
    col: 0,
    dims,
    role,
  },
});

/**
 * Map dimension magnitudes onto on-screen edge lengths.
 *
 * Linear in the dimension would make a 512x3 tensor a line — the small axis
 * collapses to nothing and the label has nowhere to sit. A square root
 * compresses the range enough to keep every edge visible while still reading as
 * "this one is much bigger than that one", which is all a figure needs to say.
 */
const edgeLengths = (dims: number[], size: number): number[] => {
  const roots = dims.map((d) => Math.sqrt(Math.max(1, Math.abs(d))));
  const longest = Math.max(...roots);
  return roots.map((r) => Math.max(MIN_EDGE, (r / longest) * size));
};

const label = (
  text: string,
  x: number,
  y: number,
  tensorId: string,
  dims: number[],
) => ({
  type: "text" as const,
  x,
  y,
  text,
  fontSize: 14,
  customData: tensorTag(tensorId, dims, "label"),
});

/** A 2-D block: one rectangle, its two dimensions written on its edges. */
export const buildTensor2D = (spec: TensorSpec): ExcalidrawElement[] => {
  const {
    x,
    y,
    dims,
    name,
    size = DEFAULT_SIZE,
    backgroundColor = "#a5d8ff",
  } = spec;
  const [rows, cols] = [dims[0] ?? 1, dims[1] ?? 1];
  const [height, width] = edgeLengths([rows, cols], size);
  const tensorId = randomId();
  const groupId = randomId();

  const skeletons = [
    {
      type: "rectangle" as const,
      x,
      y,
      width,
      height,
      groupIds: [groupId],
      backgroundColor,
      fillStyle: "solid" as const,
      roundness: null,
      customData: tensorTag(tensorId, [rows, cols], "face"),
      label: name ? { text: name, fontSize: 14 } : undefined,
    },
    // Columns along the bottom, rows down the left — the reading order of a
    // shape written `rows x cols`.
    {
      ...label(
        String(cols),
        x + width / 2 - 12,
        y + height + 6,
        tensorId,
        dims,
      ),
      groupIds: [groupId],
    },
    {
      ...label(String(rows), x - 30, y + height / 2 - 8, tensorId, dims),
      groupIds: [groupId],
    },
  ];

  return convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  );
};

/**
 * A 3-D block, drawn isometrically.
 *
 * Three faces: the front rectangle, and the top and right faces as closed
 * `line` elements. Closed lines are how Excalidraw already draws a filled
 * polygon, so the parallelograms need no new element type either — they are the
 * same primitive an arrow or a freehand outline uses.
 *
 * The two side faces are shaded darker than the front by overlaying a
 * translucent fill rather than by picking three separate colours: the canvas is
 * filtered in dark mode, so three hand-chosen hexes would drift apart under the
 * filter while one colour at three opacities stays a consistent solid.
 */
export const buildTensor3D = (spec: TensorSpec): ExcalidrawElement[] => {
  const {
    x,
    y,
    dims,
    name,
    size = DEFAULT_SIZE,
    backgroundColor = "#a5d8ff",
  } = spec;
  const [depth, height, width] = [dims[0] ?? 1, dims[1] ?? 1, dims[2] ?? 1];
  const [d, h, w] = edgeLengths([depth, height, width], size);
  const dx = d * ISO_X;
  const dy = d * ISO_Y;
  const tensorId = randomId();
  const groupId = randomId();

  // Front face sits below the depth offset so the whole block starts at `y`.
  const faceY = y + dy;

  const shared = {
    groupIds: [groupId],
    backgroundColor,
    fillStyle: "solid" as const,
    strokeWidth: 1 as const,
  };

  const skeletons = [
    {
      type: "line" as const,
      x,
      y: faceY,
      points: [
        [0, 0],
        [dx, -dy],
        [w + dx, -dy],
        [w, 0],
        [0, 0],
      ],
      ...shared,
      opacity: 70,
      customData: tensorTag(tensorId, dims, "top"),
    },
    {
      type: "line" as const,
      x: x + w,
      y: faceY,
      points: [
        [0, 0],
        [dx, -dy],
        [dx, h - dy],
        [0, h],
        [0, 0],
      ],
      ...shared,
      opacity: 85,
      customData: tensorTag(tensorId, dims, "side"),
    },
    {
      type: "rectangle" as const,
      x,
      y: faceY,
      width: w,
      height: h,
      ...shared,
      roundness: null,
      customData: tensorTag(tensorId, dims, "face"),
      label: name ? { text: name, fontSize: 14 } : undefined,
    },
    {
      ...label(String(width), x + w / 2 - 12, faceY + h + 6, tensorId, dims),
      groupIds: [groupId],
    },
    {
      ...label(String(height), x - 34, faceY + h / 2 - 8, tensorId, dims),
      groupIds: [groupId],
    },
    {
      ...label(String(depth), x + w + dx + 8, faceY - dy, tensorId, dims),
      groupIds: [groupId],
    },
  ];

  return convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  );
};

/** `[3, 224, 224]` from "3x224x224", "3, 224, 224" or "3 224 224". */
export const parseDims = (input: string): number[] =>
  input
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

/** Build whichever block the dimension count calls for. */
export const buildTensor = (spec: TensorSpec): ExcalidrawElement[] =>
  spec.dims.length >= 3 ? buildTensor3D(spec) : buildTensor2D(spec);
