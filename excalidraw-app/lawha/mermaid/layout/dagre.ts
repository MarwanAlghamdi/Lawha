/**
 * LAWHA: run the layout ourselves, with OUR node sizes.
 *
 * This is the half of route B that the upstream converter cannot do. It scrapes
 * coordinates out of a hidden SVG mermaid rendered, so the spacing it inherits
 * was computed for mermaid's boxes. Ours are different sizes — a UML class is a
 * Lawha table sized to its own text — so scraped positions would be wrong even
 * when they were readable.
 *
 * dagre-d3-es is mermaid's own layout engine, imported by subpath so no d3 and
 * no DOM comes with it. That is what keeps the whole converter headless, and
 * therefore unit-testable.
 */

import * as dagre from "dagre-d3-es/src/dagre/index.js";
import * as graphlib from "dagre-d3-es/src/graphlib/index.js";

import type { ConverterOptions } from "../options";
import type { MDiagram, MPoint } from "../model/types";

/** dagre reports a node's CENTRE. Everything downstream wants its top-left. */
const topLeft = (node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): MPoint => ({
  x: node.x - node.width / 2,
  y: node.y - node.height / 2,
});

export const layoutDiagram = (
  diagram: MDiagram,
  options: ConverterOptions,
): MDiagram => {
  const graph = new (graphlib as any).Graph({
    multigraph: true,
    compound: true,
  });
  graph.setGraph({
    rankdir: diagram.direction,
    nodesep: options.nodeSep,
    ranksep: options.rankSep,
    marginx: options.margin,
    marginy: options.margin,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of diagram.nodes) {
    graph.setNode(node.id, {
      width: node.size?.width ?? options.minNodeWidth,
      height: node.size?.height ?? options.minNodeHeight,
    });
  }

  // Clusters. dagre writes width/height back onto a cluster node, which is
  // where a subgraph's rectangle geometry comes from for free.
  for (const container of diagram.containers) {
    graph.setNode(container.id, {});
    for (const childId of container.childNodeIds) {
      if (graph.hasNode(childId)) {
        graph.setParent(childId, container.id);
      }
    }
  }
  for (const container of diagram.containers) {
    if (container.parentId && graph.hasNode(container.parentId)) {
      graph.setParent(container.id, container.parentId);
    }
  }

  // dagre cannot RANK an edge that touches a cluster — it walks the ranking
  // tree and dies on `Cannot set properties of undefined`. State diagrams hit
  // this immediately, because `Idle --> Working` legitimately points at a
  // composite state.
  //
  // So layout uses a proxy: an edge touching a container is ranked against a
  // representative child instead. The EMITTED arrow still binds to the
  // container, which is what makes it land on the container's border and
  // follow it when it is dragged — only the ranking is redirected.
  const representative = new Map<string, string>();
  for (const container of diagram.containers) {
    const child =
      container.childNodeIds.find((id) => graph.hasNode(id)) ??
      container.childContainerIds
        .flatMap(
          (id) =>
            diagram.containers.find((c) => c.id === id)?.childNodeIds ?? [],
        )
        .find((id) => graph.hasNode(id));
    if (child) {
      representative.set(container.id, child);
    }
  }
  const rankable = (id: string) => representative.get(id) ?? id;

  for (const edge of diagram.edges) {
    const from = rankable(edge.from);
    const to = rankable(edge.to);
    // A transition from a composite state to itself collapses to a self-edge
    // on its own representative, which dagre handles but which tells the
    // layout nothing. Skip it rather than distort the ranks.
    if (from === to) {
      continue;
    }
    if (!graph.hasNode(from) || !graph.hasNode(to)) {
      continue;
    }
    // An invisible link still shapes the layout — that is the entire point of
    // `~~~` — so it is fed to dagre and simply not emitted later.
    graph.setEdge(
      from,
      to,
      {
        minlen: edge.minlen ?? 1,
        // Reserve room for the label. dagre adds this to the rank gap, so
        // labelled edges get the space their text actually needs instead of
        // stacking two labels on the same point.
        ...(edge.labelSize
          ? {
              width: edge.labelSize.width,
              height: edge.labelSize.height,
              labelpos: "c",
            }
          : {}),
      },
      edge.id,
    );
  }

  (dagre as any).layout(graph);

  const nodes = diagram.nodes.map((node) => {
    const laid = graph.node(node.id);
    return laid ? { ...node, pos: topLeft(laid) } : node;
  });

  const containers = diagram.containers.map((container) => {
    const laid = graph.node(container.id);
    if (!laid || typeof laid.width !== "number") {
      return container;
    }
    return {
      ...container,
      pos: topLeft(laid),
      size: { width: laid.width, height: laid.height },
    };
  });

  const edges = diagram.edges.map((edge) => {
    // Read back against the same proxy ids the edge was ranked with.
    const laid = graph.edge(rankable(edge.from), rankable(edge.to), edge.id);
    const points: MPoint[] | undefined = laid?.points?.map((p: MPoint) => ({
      x: p.x,
      y: p.y,
    }));
    return points && points.length >= 2 ? { ...edge, points } : edge;
  });

  return { ...diagram, nodes, edges, containers };
};

/**
 * Drop points that lie on the straight line between their neighbours.
 *
 * dagre inserts a dummy node per rank an edge crosses, so a plain vertical
 * arrow arrives as three collinear points. Excalidraw would draw that as a
 * three-segment line with two draggable midpoints nobody asked for.
 */
export const simplify = (points: MPoint[], epsilon = 0.5): MPoint[] => {
  if (points.length <= 2) {
    return points;
  }
  const out: MPoint[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const current = points[i]!;
    const next = points[i + 1]!;
    const cross =
      (current.x - prev.x) * (next.y - prev.y) -
      (current.y - prev.y) * (next.x - prev.x);
    if (Math.abs(cross) > epsilon) {
      out.push(current);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
};
