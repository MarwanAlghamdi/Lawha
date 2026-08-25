/**
 * LAWHA: the positioned model -> skeletons, in draw order.
 *
 * Containers first so they land behind their contents: `ElementStore` keeps
 * insertion order, so the array order IS the z-order.
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import { emitEdge } from "./edge";
import { emitNode } from "./node";
import { ROUNDNESS_ADAPTIVE } from "./theme";

import type { ConverterOptions } from "../options";
import type { MContainer, MDiagram } from "../model/types";

const emitContainer = (
  container: MContainer,
  diagram: MDiagram,
): ExcalidrawElementSkeleton[] => {
  // Excalidraw frames cannot nest — `frame.ts` skips frames and their children
  // when computing membership — so only a top-level subgraph can be one. A
  // frame is the better artefact where it is available: named, draggable, and
  // it selects its contents.
  if (container.depth === 0) {
    const children = [
      ...container.childNodeIds,
      ...container.childContainerIds,
    ].filter(
      (id) =>
        diagram.nodes.some((node) => node.id === id) ||
        diagram.containers.some((c) => c.id === id),
    );
    if (!children.length) {
      return [];
    }
    return [
      {
        type: "frame",
        id: container.id,
        name: container.label.text || undefined,
        // No x/y/width/height: `convertToExcalidrawElements` computes the
        // bounding box from the children with 10px of padding.
        children,
      } as unknown as ExcalidrawElementSkeleton,
    ];
  }

  return [
    {
      type: "rectangle",
      id: container.id,
      x: container.pos?.x ?? 0,
      y: container.pos?.y ?? 0,
      width: container.size?.width ?? 100,
      height: container.size?.height ?? 100,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      roundness: { type: ROUNDNESS_ADAPTIVE },
      ...(container.label.text
        ? {
            label: {
              text: container.label.text,
              textAlign: "left",
              verticalAlign: "top",
            },
          }
        : {}),
    } as unknown as ExcalidrawElementSkeleton,
  ];
};

export const toSkeletons = (
  diagram: MDiagram,
  options: ConverterOptions,
): ExcalidrawElementSkeleton[] => [
  // Outermost container first. mermaid returns subgraphs INNERMOST-first, so
  // emitting them in its order draws a parent on top of the child it contains.
  ...[...diagram.containers]
    .sort((a, b) => a.depth - b.depth)
    .flatMap((container) => emitContainer(container, diagram)),
  ...diagram.nodes.flatMap((node) => emitNode(node, options)),
  ...diagram.edges.flatMap((edge) => emitEdge(edge, options)),
];
