/** LAWHA: one model node -> one or more Excalidraw element skeletons. */

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import { polygonPoints } from "./polygons";
import { ROUNDNESS_ADAPTIVE, ROUNDNESS_PROPORTIONAL } from "./theme";

import type { ConverterOptions } from "../options";
import type { MNode, MStyle } from "../model/types";

/** Only the keys that were actually set, so Excalidraw's defaults survive. */
const styleProps = (style: MStyle) => {
  const props: Record<string, unknown> = {};
  if (style.strokeColor) {
    props.strokeColor = style.strokeColor;
  }
  if (style.backgroundColor) {
    props.backgroundColor = style.backgroundColor;
  }
  // Set ONLY when a fill was asked for — see model/styles.ts.
  if (style.fillStyle) {
    props.fillStyle = style.fillStyle;
  }
  if (style.strokeWidth) {
    props.strokeWidth = style.strokeWidth;
  }
  if (style.strokeStyle) {
    props.strokeStyle = style.strokeStyle;
  }
  if (typeof style.opacity === "number") {
    props.opacity = style.opacity;
  }
  return props;
};

export const emitNode = (
  node: MNode,
  options: ConverterOptions,
): ExcalidrawElementSkeleton[] => {
  const x = node.pos?.x ?? 0;
  const y = node.pos?.y ?? 0;
  // A circle is not an oval. `A((t))` asks for a circle, so the box has to be
  // square or the label's own width quietly turns it into an ellipse.
  const rawWidth = node.size?.width ?? options.minNodeWidth;
  const rawHeight = node.size?.height ?? options.minNodeHeight;
  const side = Math.max(rawWidth, rawHeight);
  const width = node.square ? side : rawWidth;
  const height = node.square ? side : rawHeight;
  const common = {
    x,
    y,
    width,
    height,
    id: node.id,
    ...styleProps(node.style),
  };
  const label = node.label.text
    ? {
        label: {
          text: node.label.text,
          fontSize: options.fontSize,
          ...(node.style.textColor
            ? { strokeColor: node.style.textColor }
            : {}),
        },
      }
    : {};

  switch (node.shape) {
    case "table": {
      const table = node.table!;
      const rows = [table.header, ...table.rows];
      return [
        {
          ...common,
          type: "table",
          variant: "table",
          headerRow: true,
          // ADR 0027: alignment resolves per cell, so a class name can be
          // centred over left-aligned members without a second element.
          cells: rows.map((row) =>
            row.map((cell) => ({
              text: cell.text,
              fill: null,
              color: null,
              align: cell.align ?? null,
              verticalAlign: null,
              bold: cell.bold ?? null,
              italic: cell.italic ?? null,
            })),
          ),
          rows: rows.length,
          cols: table.cols,
        } as unknown as ExcalidrawElementSkeleton,
      ];
    }

    case "polygon": {
      // A closed `line` reproduces the silhouette exactly, but a line is not
      // an `ExcalidrawTextContainer`, so the label has to be its own element.
      const points = polygonPoints(node.polygon ?? "hexagon", width, height);
      const skeletons: ExcalidrawElementSkeleton[] = [
        {
          ...common,
          type: "line",
          points,
          polygon: true,
        } as unknown as ExcalidrawElementSkeleton,
      ];
      if (node.label.text) {
        skeletons.push({
          type: "text",
          x,
          y: y + height / 2 - options.fontSize / 2,
          width,
          text: node.label.text,
          fontSize: options.fontSize,
          textAlign: "center",
          ...(node.style.textColor
            ? { strokeColor: node.style.textColor }
            : {}),
        } as unknown as ExcalidrawElementSkeleton);
      }
      return skeletons;
    }

    case "ellipse": {
      const skeletons: ExcalidrawElementSkeleton[] = [
        { ...common, type: "ellipse", ...label } as ExcalidrawElementSkeleton,
      ];
      if (node.inset) {
        // `A(((t)))` — a double circle. The inner ring is its own element
        // rather than a stroke trick, so it survives export and re-theming.
        const gap = Math.max(6, Math.min(width, height) * 0.09);
        skeletons.push({
          ...common,
          id: `${node.id}__inner`,
          type: "ellipse",
          x: x + gap,
          y: y + gap,
          width: width - gap * 2,
          height: height - gap * 2,
          // The label belongs to the outer ring; two labels would overlap.
          label: undefined,
        } as unknown as ExcalidrawElementSkeleton);
      }
      return skeletons;
    }

    case "diamond":
      return [
        { ...common, type: "diamond", ...label } as ExcalidrawElementSkeleton,
      ];

    case "rounded":
      return [
        {
          ...common,
          type: "rectangle",
          roundness: { type: ROUNDNESS_PROPORTIONAL },
          ...label,
        } as unknown as ExcalidrawElementSkeleton,
      ];

    case "rectangle":
    default:
      return [
        {
          ...common,
          type: "rectangle",
          ...(node.style.rounded
            ? { roundness: { type: ROUNDNESS_ADAPTIVE } }
            : {}),
          ...label,
        } as unknown as ExcalidrawElementSkeleton,
      ];
  }
};
