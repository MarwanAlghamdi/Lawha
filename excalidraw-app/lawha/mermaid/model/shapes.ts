/**
 * LAWHA: mermaid's vertex type -> something Lawha can draw.
 *
 * This is a TOTAL function. An unrecognised type becomes a rectangle and a
 * warning, never a crash. That matters because mermaid 11 accepts ~138 shape
 * ids via `A@{ shape: X }` and adds more every minor release.
 *
 * The upstream converter's enum has six members and its switch branches on
 * five — `cylinder` is in the enum with no case, so a database node silently
 * renders as a plain rectangle, and hexagon, trapezoid, parallelogram and
 * subroutine are not represented at all.
 */

import type { LawhaShape } from "./types";

export interface ShapeResolution {
  shape: LawhaShape;
  /** A polygon needs its own point generator; this names which. */
  polygon?: PolygonKind;
  /** Force a square bounding box (circles). */
  square?: boolean;
  /** Draw a second, inset outline (double circle). */
  inset?: boolean;
  /** Mermaid knew this shape and we do not draw it exactly. */
  approximated?: boolean;
}

export type PolygonKind =
  | "hexagon"
  | "trapezoid"
  | "invTrapezoid"
  | "leanRight"
  | "leanLeft"
  | "flag";

/**
 * The legacy jison vertex types, which is the complete universe for ordinary
 * flowchart syntax. `undefined` is included deliberately: a bare `A` with no
 * bracket has no `type` at all, and a switch without that case defaults it to
 * something wrong.
 */
const LEGACY: Record<string, ShapeResolution> = {
  square: { shape: "rectangle" },
  rect: { shape: "rectangle" },
  round: { shape: "rounded" },
  stadium: { shape: "rounded", approximated: true },
  circle: { shape: "ellipse", square: true },
  doublecircle: { shape: "ellipse", square: true, inset: true },
  ellipse: { shape: "ellipse" },
  diamond: { shape: "diamond" },
  hexagon: { shape: "polygon", polygon: "hexagon" },
  odd: { shape: "polygon", polygon: "flag" },
  trapezoid: { shape: "polygon", polygon: "trapezoid" },
  inv_trapezoid: { shape: "polygon", polygon: "invTrapezoid" },
  lean_right: { shape: "polygon", polygon: "leanRight" },
  lean_left: { shape: "polygon", polygon: "leanLeft" },
  // Drawn as a rectangle plus decoration by `emit/node.ts`; both bind.
  subroutine: { shape: "rectangle" },
  cylinder: { shape: "rectangle", approximated: true },
};

export const resolveShape = (
  vertexType: string | undefined,
  preferBindable: boolean,
): ShapeResolution & { recognised: boolean } => {
  // A bare `A`. Not an error, and not a stadium.
  if (!vertexType) {
    return { shape: "rectangle", recognised: true };
  }
  const found = LEGACY[vertexType];
  if (!found) {
    return { shape: "rectangle", recognised: false };
  }
  if (preferBindable && found.shape === "polygon") {
    // Trade the silhouette for an arrow that re-routes when the node moves.
    return { shape: "rectangle", recognised: true, approximated: true };
  }
  return { ...found, recognised: true };
};
