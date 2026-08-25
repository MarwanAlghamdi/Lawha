/**
 * LAWHA: mermaid's FlowDB -> the intermediate model.
 *
 * Every fidelity fix ADR 0028 §"specific losses" lists is in this file:
 * `cylinder` has a case, `~~~` is honoured as invisible, dotted and dashed are
 * distinguished, and `fillStyle` is left unset unless a fill was asked for.
 */

import type { Arrowhead, StrokeStyle } from "@excalidraw/element/types";

import { resolveShape } from "./shapes";
import { mergeStyles, parseDeclarations } from "./styles";
import { labelText } from "./text";

import type { ConverterOptions } from "../options";
import type {
  Direction,
  MContainer,
  MDiagram,
  MEdge,
  MNode,
  MWarning,
} from "./types";

/**
 * Mermaid's seven edge types.
 *
 * Excalidraw has no cross arrowhead, so `x` becomes `bar` — the nearest thing
 * that still reads as "terminated rather than pointing". `arrow_open` really
 * is no head at all, which is the one the upstream map gets right by omission.
 */
const ARROWHEADS: Record<
  string,
  { start: Arrowhead | null; end: Arrowhead | null }
> = {
  arrow_point: { start: null, end: "arrow" },
  arrow_circle: { start: null, end: "circle" },
  arrow_cross: { start: null, end: "bar" },
  arrow_open: { start: null, end: null },
  double_arrow_point: { start: "arrow", end: "arrow" },
  double_arrow_circle: { start: "circle", end: "circle" },
  double_arrow_cross: { start: "bar", end: "bar" },
};

const DIRECTIONS = new Set(["TB", "BT", "LR", "RL"]);

const normaliseDirection = (raw: unknown): Direction => {
  const value = String(raw ?? "TB").toUpperCase();
  // mermaid already folds TD -> TB, v -> TB, ^ -> BT, > -> LR, < -> RL, but a
  // stray value should not silently become a sideways diagram.
  return (DIRECTIONS.has(value) ? value : "TB") as Direction;
};

/** `getVertices()` and `getClasses()` are Maps; older shapes were objects. */
const asEntries = <T>(value: any): [string, T][] => {
  if (!value) {
    return [];
  }
  return typeof value.entries === "function"
    ? Array.from(value.entries() as Iterable<[string, T]>)
    : Object.entries(value as Record<string, T>);
};

export const fromFlowchart = (db: any, options: ConverterOptions): MDiagram => {
  const warnings: MWarning[] = [];
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];
  const containers: MContainer[] = [];

  const classDefs = new Map(asEntries<any>(db.getClasses?.()));

  for (const [id, vertex] of asEntries<any>(db.getVertices?.())) {
    const resolved = resolveShape(vertex?.type, options.preferBindableShapes);
    if (!resolved.recognised) {
      warnings.push({
        code: "unsupported-shape",
        detail: `"${vertex?.type}" on node ${id} — drawn as a rectangle`,
      });
    }

    const classStyles = (vertex?.classes ?? []).flatMap(
      (name: string) => classDefs.get(name)?.styles ?? [],
    );
    const style = mergeStyles(
      parseDeclarations(classStyles),
      parseDeclarations(vertex?.styles ?? []),
    );
    if (resolved.shape === "rounded" || resolved.approximated) {
      style.rounded = style.rounded ?? resolved.shape === "rounded";
    }

    const raw = typeof vertex?.text === "string" ? vertex.text : id;
    const wasMarkdown = vertex?.labelType === "markdown";
    if (wasMarkdown) {
      warnings.push({
        code: "markdown-flattened",
        detail: `node ${id} — Excalidraw text has no bold or italic runs`,
      });
    }

    nodes.push({
      id,
      shape: resolved.shape,
      polygon: resolved.polygon,
      square: resolved.square,
      inset: resolved.inset,
      label: { text: labelText(raw), wasMarkdown },
      style,
      link: typeof vertex?.link === "string" ? vertex.link : undefined,
    });
  }

  const known = new Set(nodes.map((node) => node.id));

  const rawEdges: any[] = Array.from(db.getEdges?.() ?? []);
  rawEdges.forEach((edge, index) => {
    // An edge naming a vertex that does not exist would produce an arrow bound
    // to nothing, which `convertToExcalidrawElements` reports only through
    // console.error. Drop it here, loudly.
    if (!known.has(edge?.start) || !known.has(edge?.end)) {
      warnings.push({
        code: "unbound-arrow",
        detail: `edge ${edge?.start} -> ${edge?.end} names a node that does not exist`,
      });
      return;
    }

    const stroke = String(edge?.stroke ?? "normal");
    let strokeStyle: StrokeStyle = "solid";
    let strokeWidth = 2;
    if (stroke === "thick") {
      strokeWidth = 4;
    } else if (stroke === "dotted") {
      // `-.-` is dotted. Mapping it to dashed loses a distinction mermaid draws.
      strokeStyle = "dotted";
    }

    const heads = ARROWHEADS[String(edge?.type ?? "arrow_point")] ?? {
      start: null,
      end: "arrow" as Arrowhead,
    };

    const text = labelText(edge?.text);

    edges.push({
      id: `edge-${index}-${edge.start}-${edge.end}`,
      from: edge.start,
      to: edge.end,
      label: text ? { text } : undefined,
      startArrowhead: heads.start,
      endArrowhead: heads.end,
      strokeStyle,
      strokeWidth,
      // `A ---> B` asks for two ranks of separation. Mermaid clamps at 10.
      minlen: Math.max(1, Math.min(10, Number(edge?.length) || 1)),
      invisible: stroke === "invisible",
    });
  });

  // Subgraphs come back innermost-first. A child's id appears in its parent's
  // `nodes` array, which is how nesting is discovered.
  const subGraphs: any[] = Array.from(db.getSubGraphs?.() ?? []);
  const subGraphIds = new Set(subGraphs.map((sub) => sub.id));

  for (const sub of subGraphs) {
    const members: string[] = Array.from(sub?.nodes ?? []);
    containers.push({
      id: sub.id,
      label: { text: labelText(sub?.title) },
      depth: 0,
      childNodeIds: members.filter((member) => known.has(member)),
      childContainerIds: members.filter((member) => subGraphIds.has(member)),
      style: {},
    });
    if (sub?.dir) {
      warnings.push({
        code: "nested-direction-ignored",
        detail: `subgraph ${sub.id} asked for direction ${sub.dir}; a layout has one rank direction`,
      });
    }
  }

  // Depth: a container named as another's child is one level deeper. Frames
  // cannot nest in Excalidraw, so depth decides frame vs dashed rectangle.
  const byId = new Map(
    containers.map((container) => [container.id, container]),
  );
  for (const container of containers) {
    for (const childId of container.childContainerIds) {
      const child = byId.get(childId);
      if (child) {
        child.parentId = container.id;
      }
    }
  }
  const assignDepth = (container: MContainer, depth: number) => {
    container.depth = depth;
    for (const childId of container.childContainerIds) {
      const child = byId.get(childId);
      if (child) {
        assignDepth(child, depth + 1);
      }
    }
  };
  for (const container of containers) {
    if (!container.parentId) {
      assignDepth(container, 0);
    }
  }

  // Node -> container membership, so layout can nest them.
  for (const container of containers) {
    for (const childId of container.childNodeIds) {
      const node = nodes.find((candidate) => candidate.id === childId);
      if (node) {
        node.parentId = container.id;
      }
    }
  }

  return {
    kind: "flowchart",
    direction: normaliseDirection(db.getDirection?.()),
    nodes,
    edges,
    containers,
    warnings,
  };
};
