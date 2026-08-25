/**
 * LAWHA: mermaid's StateDB -> the intermediate model.
 *
 * Built on `db.getData()`, deliberately, and NOT on `getStates()`/
 * `getRelations()`: those read the ROOT document only, so every state nested
 * inside a composite state is silently missing. `getData()` returns the graph
 * already flattened, with `parentId` set and a `shape` per node — which is
 * also how the nesting becomes containers without a recursive walk.
 *
 * Terminals are the other trap. `[*]` arrives as a node whose `label` is its
 * own generated id (`root_start`, `Working_start`), so anything that trusts
 * the label draws the word "root_start" on the canvas.
 */

import { labelText } from "./text";

import type { ConverterOptions } from "../options";
import type {
  LawhaShape,
  MContainer,
  MDiagram,
  MEdge,
  MNode,
  MWarning,
} from "./types";

/** A terminal or junction: laid out, drawn small, and never labelled. */
const UNLABELLED = new Set(["stateStart", "stateEnd", "fork", "join"]);

interface ShapeRule {
  shape: LawhaShape;
  square?: boolean;
  inset?: boolean;
  /** Fixed size, in scene units, for the marks UML draws at a constant size. */
  size?: { width: number; height: number };
  /** Filled with the stroke colour — a start marker is a solid dot. */
  solid?: boolean;
}

const SHAPES: Record<string, ShapeRule> = {
  // A start marker is a filled dot, and an end marker is the same with a ring.
  stateStart: {
    shape: "ellipse",
    square: true,
    size: { width: 18, height: 18 },
    solid: true,
  },
  stateEnd: {
    shape: "ellipse",
    square: true,
    size: { width: 22, height: 22 },
    inset: true,
    solid: true,
  },
  // A UML state is a rounded box; a plain rectangle reads as an activity.
  rect: { shape: "rounded" },
  roundedRect: { shape: "rounded" },
  // A choice pseudostate is a diamond, like a flowchart decision.
  choice: { shape: "diamond", square: true, size: { width: 36, height: 36 } },
  // Fork and join are thick bars.
  fork: { shape: "rectangle", size: { width: 90, height: 8 }, solid: true },
  join: { shape: "rectangle", size: { width: 90, height: 8 }, solid: true },
  note: { shape: "rectangle" },
};

const GROUP_SHAPES = new Set([
  "roundedWithTitle",
  "rectWithTitle",
  "noteGroup",
  "divider",
]);

export const fromState = (db: any, options: ConverterOptions): MDiagram => {
  const warnings: MWarning[] = [];
  const nodes: MNode[] = [];
  const containers: MContainer[] = [];
  const edges: MEdge[] = [];

  const data = db.getData?.();
  if (!data?.nodes) {
    warnings.push({
      code: "unsupported-shape",
      detail: "this mermaid build exposes no getData() for state diagrams",
    });
    return {
      kind: "state",
      direction: "TB",
      nodes,
      edges,
      containers,
      warnings,
    };
  }

  for (const node of data.nodes as any[]) {
    const id = String(node?.id);
    const shapeId = String(node?.shape ?? "rect");

    if (node?.isGroup || GROUP_SHAPES.has(shapeId)) {
      containers.push({
        id,
        label: { text: labelText(node?.label) },
        // Depth is resolved below, once every parent is known.
        depth: 0,
        parentId: node?.parentId ? String(node.parentId) : undefined,
        childNodeIds: [],
        childContainerIds: [],
        style: {},
      });
      continue;
    }

    const rule = SHAPES[shapeId] ?? { shape: "rounded" as LawhaShape };
    if (!SHAPES[shapeId]) {
      warnings.push({
        code: "unsupported-shape",
        detail: `state shape "${shapeId}" on ${id} — drawn as a rounded box`,
      });
    }

    nodes.push({
      id,
      shape: rule.shape,
      square: rule.square,
      inset: rule.inset,
      // A terminal's label is its own generated id. Drawing it puts the word
      // "root_start" on the canvas, which is how you can spot a converter
      // that trusted the field.
      label: { text: UNLABELLED.has(shapeId) ? "" : labelText(node?.label) },
      parentId: node?.parentId ? String(node.parentId) : undefined,
      style: rule.solid
        ? { backgroundColor: "#1e1e1e", fillStyle: "solid" }
        : {},
      size: rule.size,
    });
  }

  // Wire membership now that every container exists.
  const containerById = new Map(containers.map((c) => [c.id, c]));
  for (const node of nodes) {
    const parent = node.parentId && containerById.get(node.parentId);
    if (parent) {
      parent.childNodeIds.push(node.id);
    }
  }
  for (const container of containers) {
    const parent = container.parentId && containerById.get(container.parentId);
    if (parent) {
      parent.childContainerIds.push(container.id);
    }
  }
  const assignDepth = (container: MContainer, depth: number) => {
    container.depth = depth;
    for (const childId of container.childContainerIds) {
      const child = containerById.get(childId);
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

  const known = new Set([
    ...nodes.map((n) => n.id),
    ...containers.map((c) => c.id),
  ]);

  (data.edges as any[] | undefined)?.forEach((edge, index) => {
    const from = String(edge?.start);
    const to = String(edge?.end);
    if (!known.has(from) || !known.has(to)) {
      warnings.push({
        code: "unbound-arrow",
        detail: `transition ${from} -> ${to} names a state that does not exist`,
      });
      return;
    }
    const label = labelText(edge?.label);
    edges.push({
      id: `state-${index}-${from}-${to}`,
      from,
      to,
      label: label ? { text: label } : undefined,
      startArrowhead: null,
      endArrowhead: "arrow",
      strokeStyle: "solid",
      strokeWidth: 2,
      minlen: 1,
    });
  });

  void options;
  return {
    kind: "state",
    direction: String(db.getDirection?.() ?? "TB").toUpperCase() as any,
    nodes,
    edges,
    containers,
    warnings,
  };
};
