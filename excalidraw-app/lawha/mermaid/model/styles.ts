/**
 * LAWHA: mermaid's CSS declaration strings -> Excalidraw style.
 *
 * Input is raw `"prop:value"` fragments from `classDef`, `style X ...` and
 * `:::`. Resolution order is classDef first, then element-level, so the more
 * specific wins — which is what CSS itself would do.
 *
 * The bug this fixes: the upstream converter sets `fillStyle: "solid"`
 * unconditionally, so a node nobody styled gets a flat solid fill on a
 * hand-drawn canvas, where every other shape is hachured. **`fillStyle` is set
 * only when a fill was actually asked for.**
 */

import type { FillStyle, StrokeStyle } from "@excalidraw/element/types";

import type { MStyle } from "./types";

const TRANSPARENT = new Set(["none", "transparent", "inherit"]);

/** Excalidraw offers exactly three stroke widths. */
const nearestStrokeWidth = (px: number): number =>
  [1, 2, 4].reduce(
    (best, w) => (Math.abs(w - px) < Math.abs(best - px) ? w : best),
    2,
  );

const dashToStrokeStyle = (value: string): StrokeStyle => {
  const first = Number.parseFloat(value.trim().split(/[\s,]+/)[0] ?? "0");
  // A short dash reads as a dot; a long one reads as a dash. Mapping every
  // dasharray to "dashed" loses the distinction mermaid was drawing.
  return Number.isFinite(first) && first <= 2 ? "dotted" : "dashed";
};

export const parseDeclarations = (decls: readonly string[]): MStyle => {
  const style: MStyle = {};
  let hasFill = false;
  let fillOpacity: number | null = null;

  for (const decl of decls) {
    const index = decl.indexOf(":");
    if (index < 0) {
      continue;
    }
    const prop = decl.slice(0, index).trim().toLowerCase();
    const value = decl.slice(index + 1).trim();
    if (!value) {
      continue;
    }

    switch (prop) {
      case "fill":
        if (TRANSPARENT.has(value.toLowerCase())) {
          style.backgroundColor = "transparent";
          // Deliberately no fillStyle: there is nothing to fill.
        } else {
          style.backgroundColor = value;
          hasFill = true;
        }
        break;
      case "stroke":
        style.strokeColor = TRANSPARENT.has(value.toLowerCase())
          ? "transparent"
          : value;
        break;
      case "stroke-width":
        style.strokeWidth = nearestStrokeWidth(Number.parseFloat(value) || 2);
        break;
      case "stroke-dasharray":
        style.strokeStyle = dashToStrokeStyle(value);
        break;
      case "color":
        style.textColor = value;
        break;
      case "opacity":
        style.opacity = Math.max(
          0,
          Math.min(100, Math.round(Number.parseFloat(value) * 100)),
        );
        break;
      case "fill-opacity":
        fillOpacity = Number.parseFloat(value);
        break;
      case "rx":
      case "ry":
        if ((Number.parseFloat(value) || 0) > 0) {
          style.rounded = true;
        }
        break;
      default:
        break;
    }
  }

  if (hasFill) {
    // A translucent fill reads as a hatch far better than a flat wash, and
    // hachure is what the rest of a hand-drawn canvas looks like anyway.
    style.fillStyle =
      fillOpacity !== null && fillOpacity < 1
        ? ("hachure" as FillStyle)
        : ("solid" as FillStyle);
  }

  return style;
};

/** classDef styles first, then the element's own. Later wins. */
export const mergeStyles = (...layers: MStyle[]): MStyle =>
  layers.reduce<MStyle>((acc, layer) => ({ ...acc, ...layer }), {});
