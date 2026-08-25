import { newTensorElement } from "../src/newElement";
import {
  edgeLengths,
  isVolumetric,
  parseDims,
  resolveTensorLabels,
  STACK_LAYERS,
  tensorGeometry,
  tensorLayout,
  tensorShapeAlphas,
} from "../src/tensorElement";

import type { ExcalidrawTensorElement } from "../src/types";

const tensor = (
  dims: readonly number[],
  overrides: { width?: number; height?: number; fontSize?: number } = {},
): ExcalidrawTensorElement =>
  newTensorElement({
    x: 0,
    y: 0,
    width: overrides.width ?? 260,
    height: overrides.height ?? 190,
    dims,
    ...(overrides.fontSize === undefined
      ? {}
      : { fontSize: overrides.fontSize }),
  });

/**
 * How many roughjs shapes `generateTensorShapes` will emit, without a
 * generator. Faces per box times boxes; the alpha array is one per shape, so
 * asserting its length is asserting the shape count.
 */
const shapeCount = (element: ExcalidrawTensorElement) =>
  tensorShapeAlphas(element).length;

describe("parseDims", () => {
  it("reads the separators people actually type", () => {
    expect(parseDims("64x32x32")).toEqual([64, 32, 32]);
    expect(parseDims("64, 32, 32")).toEqual([64, 32, 32]);
    expect(parseDims("64 × 32 × 32")).toEqual([64, 32, 32]);
    expect(parseDims("  128 16 8 ")).toEqual([128, 16, 8]);
  });

  it("keeps a two-dimensional shape two-dimensional", () => {
    expect(parseDims("28 x 28")).toEqual([28, 28]);
  });

  it("keeps every axis of a four-dimensional shape", () => {
    // The shape a batch of feature maps is written as, and the one the
    // renderer used to silently truncate to three.
    expect(parseDims("8 x 64 x 32 x 32")).toEqual([8, 64, 32, 32]);
  });

  it("drops values that would collapse a face rather than accepting them", () => {
    expect(parseDims("64 x 0 x 32")).toEqual([64, 32]);
    expect(parseDims("-8 x 16")).toEqual([8, 16]);
  });

  it("returns nothing for a draft with no numbers, so callers can keep the old shape", () => {
    expect(parseDims("")).toEqual([]);
    expect(parseDims("batch x channels")).toEqual([]);
  });
});

describe("tensorLayout", () => {
  it("splits a rank-4 shape into a stack count and a drawable core", () => {
    expect(tensorLayout(tensor([8, 64, 32, 32]))).toMatchObject({
      rank: 4,
      lead: [8],
      core: [64, 32, 32],
      volumetric: true,
      stacked: true,
    });
  });

  it("keeps every leading axis of a rank-5 shape", () => {
    expect(tensorLayout(tensor([2, 8, 64, 32, 32]))).toMatchObject({
      lead: [2, 8],
      core: [64, 32, 32],
    });
  });

  it("leaves rank 1 to 3 exactly as they were", () => {
    expect(tensorLayout(tensor([512]))).toMatchObject({
      lead: [],
      core: [512],
      volumetric: false,
      stacked: false,
    });
    expect(tensorLayout(tensor([28, 28]))).toMatchObject({
      core: [28, 28],
      volumetric: false,
      stacked: false,
    });
    expect(tensorLayout(tensor([64, 32, 16]))).toMatchObject({
      core: [64, 32, 16],
      volumetric: true,
      stacked: false,
    });
  });

  it("calls a rank-4 tensor volumetric — the box is the core, not the whole shape", () => {
    expect(isVolumetric(tensor([8, 64, 32, 32]))).toBe(true);
    expect(isVolumetric(tensor([28, 28]))).toBe(false);
  });
});

describe("edgeLengths", () => {
  it("compresses by the square root, keeping the ordering", () => {
    const [a, b] = edgeLengths([100, 25], 200);
    expect(a).toBeCloseTo(200);
    // sqrt(25)/sqrt(100) = 0.5 — half, not a quarter.
    expect(b).toBeCloseTo(100);
  });

  it("is a no-op on one axis, which is why nothing may call it that way", () => {
    // Pinned as a warning rather than as desired behaviour: `tensorGeometry`
    // passed a one-element array for years, so the isometric lean was the same
    // size for every tensor ever drawn and the compression above did nothing.
    expect(edgeLengths([2], 200)).toEqual([200]);
    expect(edgeLengths([512], 200)).toEqual([200]);
  });
});

describe("tensorGeometry", () => {
  it("leans further back for a deeper tensor", () => {
    // The regression this file exists for. `[2,64,32]` and `[512,64,32]` used
    // to produce a pixel-identical box.
    const shallow = tensorGeometry(tensor([2, 64, 32]));
    const deep = tensorGeometry(tensor([512, 64, 32]));

    expect(deep.dx).toBeGreaterThan(shallow.dx);
    expect(deep.dy).toBeGreaterThan(shallow.dy);
  });

  it.each([
    [[512]],
    [[28, 28]],
    [[64, 32, 16]],
    [[8, 64, 32, 32]],
    [[2, 8, 64, 32, 32]],
  ])("keeps every drawn edge of %j inside the element's own box", (dims) => {
    const element = tensor(dims);
    const g = tensorGeometry(element);

    // The back-most ghost is the extreme in both axes: furthest right, and
    // highest once the isometric lean is added on top of the stack lean.
    const right = g.faceX + g.faceWidth + g.dx + g.stepX * g.layers;
    const top = g.faceY - g.dy - g.stepY * g.layers;
    const bottom = g.faceY + g.faceHeight;

    expect(g.faceX).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(element.width);
    expect(bottom).toBeLessThanOrEqual(element.height);
  });

  it("scales its gutters with the font, so a big label still fits", () => {
    const small = tensorGeometry(tensor([64, 32, 16], { fontSize: 14 }));
    const large = tensorGeometry(tensor([64, 32, 16], { fontSize: 40 }));

    // A 40px label used to draw into a gutter sized for a 14px one and out
    // through the side of the element.
    expect(large.faceX).toBeGreaterThan(small.faceX);
    expect(large.faceWidth).toBeLessThan(small.faceWidth);
  });

  it("reserves nothing for a stack below rank 4", () => {
    expect(tensorGeometry(tensor([64, 32, 16])).layers).toBe(0);
    expect(tensorGeometry(tensor([8, 64, 32, 32])).layers).toBe(STACK_LAYERS);
  });
});

describe("tensorShapeAlphas", () => {
  it("emits one alpha per shape at every rank", () => {
    // Flat: one rectangle. Volumetric: three faces. Stacked: three per layer,
    // plus the front box.
    expect(shapeCount(tensor([28, 28]))).toBe(1);
    expect(shapeCount(tensor([64, 32, 16]))).toBe(3);
    expect(shapeCount(tensor([8, 64, 32, 32]))).toBe(3 * (STACK_LAYERS + 1));
  });

  it("fades the ghosts and leaves the front box alone", () => {
    const alphas = tensorShapeAlphas(tensor([8, 64, 32, 32]));

    // The front box keeps the face table unmodified.
    expect(alphas.slice(-3)).toEqual([0.55, 0.75, 1]);

    // Compared face against the SAME face, box by box, because a ghost's front
    // rectangle and the front box's *top* polygon can legitimately share a
    // number — they are different faces. What must hold is that each box is
    // strictly fainter than the one in front of it.
    //
    // The old arithmetic — `shapes.length - TENSOR_FACE_ALPHAS.length` — gave
    // every shape but the last three an alpha of 1, so the ghosts drew solid,
    // back over front, as one opaque smear.
    for (let face = 0; face < 3; face++) {
      const column = [0, 1, 2].map((box) => alphas[box * 3 + face]!);
      expect(column[0]).toBeLessThan(column[1]!);
      expect(column[1]).toBeLessThan(column[2]!);
    }
  });

  it("gives a flat tensor a single opaque shape", () => {
    expect(tensorShapeAlphas(tensor([28, 28]))).toEqual([1]);
  });
});

describe("resolveTensorLabels", () => {
  const texts = (dims: readonly number[]) =>
    resolveTensorLabels(tensor(dims)).map((label) => label.text);

  it("writes one label per axis of a rank-3 tensor", () => {
    expect(texts([64, 32, 16]).sort()).toEqual(["16", "32", "64"]);
  });

  it("writes the leading axes of a rank-4 tensor as a multiplier", () => {
    // Every number in the shape reaches the drawing. It used to lose the last
    // one entirely and label the batch size as the depth.
    expect(texts([8, 64, 32, 32])).toContain("8 ×");
    expect(texts([8, 64, 32, 32])).toContain("64");
    expect(texts([8, 64, 32, 32]).filter((t) => t === "32")).toHaveLength(2);
  });

  it("joins several leading axes rather than dropping all but one", () => {
    expect(texts([2, 8, 64, 32, 32])).toContain("2 × 8 ×");
  });

  it("writes exactly one label for a rank-1 tensor", () => {
    // Was two: the missing column was drawn as an empty string at a real
    // coordinate, which is a text node in the SVG export with no content.
    expect(texts([512])).toEqual(["512"]);
  });

  it("puts the name on the front face without displacing an axis", () => {
    const labels = resolveTensorLabels(
      newTensorElement({
        x: 0,
        y: 0,
        width: 260,
        height: 190,
        dims: [64, 32, 16],
        name: "conv1",
      }),
    );

    expect(labels.map((l) => l.text)).toContain("conv1");
    expect(labels.find((l) => l.text === "conv1")?.baseline).toBe("middle");
    expect(labels).toHaveLength(4);
  });

  it.each([
    [[512]],
    [[28, 28]],
    [[64, 32, 16]],
    [[8, 64, 32, 32]],
    [[2, 8, 64, 32, 32]],
  ])("anchors every label of %j inside the element", (dims) => {
    const element = tensor(dims);

    for (const label of resolveTensorLabels(element)) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.x).toBeLessThanOrEqual(element.width);
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.y).toBeLessThanOrEqual(element.height);
    }
  });

  it("never emits an empty label", () => {
    for (const dims of [[512], [28, 28], [64, 32, 16], [8, 64, 32, 32]]) {
      for (const label of resolveTensorLabels(tensor(dims))) {
        expect(label.text).not.toBe("");
      }
    }
  });
});
