/**
 * LAWHA: point generators for the shapes Excalidraw has no primitive for.
 *
 * Each returns points in element-local space starting at (0, 0), which is what
 * a closed `line` skeleton wants. Pure functions, so they are exhaustively
 * unit-testable without a canvas.
 *
 * The upstream converter draws every one of these as a plain rectangle: its
 * shape enum has six members and no case for four of them.
 */

import type { PolygonKind } from "../model/shapes";

export type LocalPoints = [number, number][];

const notch = (width: number) => Math.min(24, width * 0.2);

export const polygonPoints = (
  kind: PolygonKind,
  width: number,
  height: number,
): LocalPoints => {
  const n = notch(width);
  switch (kind) {
    case "hexagon":
      return [
        [n, 0],
        [width - n, 0],
        [width, height / 2],
        [width - n, height],
        [n, height],
        [0, height / 2],
        [n, 0],
      ];
    case "trapezoid":
      // `A[/t\]` — narrower at the top.
      return [
        [n, 0],
        [width - n, 0],
        [width, height],
        [0, height],
        [n, 0],
      ];
    case "invTrapezoid":
      // `A[\t/]` — narrower at the bottom.
      return [
        [0, 0],
        [width, 0],
        [width - n, height],
        [n, height],
        [0, 0],
      ];
    case "leanRight":
      // `A[/t/]` — a parallelogram skewed right.
      return [
        [n, 0],
        [width, 0],
        [width - n, height],
        [0, height],
        [n, 0],
      ];
    case "leanLeft":
      // `A[\t\]` — the mirror of leanRight.
      return [
        [0, 0],
        [width - n, 0],
        [width, height],
        [n, height],
        [0, 0],
      ];
    case "flag":
      // `A>t]` — the ribbon/flag shape.
      return [
        [0, 0],
        [width - n, 0],
        [width, height / 2],
        [width - n, height],
        [0, height],
        [n, height / 2],
        [0, 0],
      ];
    default:
      return [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
        [0, 0],
      ];
  }
};
