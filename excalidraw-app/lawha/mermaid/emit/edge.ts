/** LAWHA: one model edge -> one arrow skeleton, bound at both ends. */

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import { simplify } from "../layout/dagre";

import type { ConverterOptions } from "../options";
import type { MEdge } from "../model/types";

export const emitEdge = (
  edge: MEdge,
  options: ConverterOptions,
): ExcalidrawElementSkeleton[] => {
  // `~~~` shapes the layout and draws nothing. The upstream converter renders
  // it as an ordinary solid arrow, which is the opposite of what it means.
  if (edge.invisible) {
    return [];
  }

  const points = simplify(edge.points ?? []);
  const first = points[0];
  const last = points[points.length - 1];

  const geometry =
    first && last
      ? {
          x: first.x,
          y: first.y,
          points: points.map((point) => [point.x - first.x, point.y - first.y]),
        }
      : { x: 0, y: 0 };

  return [
    {
      type: "arrow",
      id: edge.id,
      ...geometry,
      // `start`/`end` by id is the ONLY route to a real binding: the arrow
      // constructor hard-sets startBinding/endBinding to null, so a binding
      // passed through a skeleton would be dropped.
      start: { id: edge.from },
      end: { id: edge.to },
      startArrowhead: edge.startArrowhead,
      endArrowhead: edge.endArrowhead,
      strokeStyle: edge.strokeStyle,
      strokeWidth: edge.strokeWidth,
      ...(edge.strokeColor ? { strokeColor: edge.strokeColor } : {}),
      ...(edge.label
        ? { label: { text: edge.label.text, fontSize: options.fontSize } }
        : {}),
    } as unknown as ExcalidrawElementSkeleton,
  ];
};
