/**
 * LAWHA: the intermediate model every diagram type maps into.
 *
 * This file is the whole contract between `model/from*.ts` and everything
 * downstream. Its point is that `layout/` and `emit/` are written ONCE and
 * tested once, rather than once per diagram type — which is what the upstream
 * converter does, at a cost of 805 lines for class diagrams alone.
 *
 * Two invariants make that pay:
 *
 *  1. **No mermaid type crosses this file.** `model/` imports mermaid; nothing
 *     downstream does.
 *  2. **`MEdge.from`/`to` always name an `MNode.id` that exists.** Every
 *     id-resolution trap lives inside `from*.ts` — mermaid's ER relationships
 *     reference `entity-CUSTOMER-0` while its entity map is keyed by
 *     `CUSTOMER`, and a converter that misses that emits arrows to nowhere.
 */

import type {
  Arrowhead,
  FillStyle,
  StrokeStyle,
} from "@excalidraw/element/types";

import type { PolygonKind } from "./shapes";

export type DiagramKind = "flowchart" | "class" | "er" | "state";
export type Direction = "TB" | "BT" | "LR" | "RL";

/**
 * What we can actually draw.
 *
 * `model/shapes.ts` is a TOTAL function into this — an unrecognised mermaid
 * shape becomes a rectangle plus a warning, never a crash and never a silently
 * wrong picture.
 */
export type LawhaShape =
  /** Native Excalidraw primitives: bindable, can carry bound text. */
  | "rectangle"
  | "rounded"
  | "ellipse"
  | "diamond"
  /** A native Lawha element type. Bindable since ADR 0027's sibling patch. */
  | "table"
  /** A closed `line` with `polygon: true`. Exact silhouette, NOT bindable. */
  | "polygon";

export interface MPoint {
  x: number;
  y: number;
}

export interface MSize {
  width: number;
  height: number;
}

/** Resolved visual style, already in Excalidraw's vocabulary. */
export interface MStyle {
  strokeColor?: string;
  backgroundColor?: string;
  /**
   * Deliberately optional. Unset means "whatever Excalidraw defaults to", NOT
   * `"solid"` — the upstream converter sets solid unconditionally, so an
   * unstyled node gets a solid fill style on a hand-drawn canvas.
   */
  fillStyle?: FillStyle;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  opacity?: number;
  /** Label ink. `color:` and `stroke:` are different CSS properties. */
  textColor?: string;
  rounded?: boolean;
}

export interface MLabel {
  /** Plain text: entity-decoded, markdown already flattened. */
  text: string;
  /** Mermaid said this label was markdown. Kept so we can warn, not render. */
  wasMarkdown?: boolean;
}

/** A `table` payload. Mermaid only ever produces `variant: "table"`. */
export interface MTable {
  /** Row 0, drawn as the header. */
  header: MCell[];
  rows: MCell[][];
  cols: number;
}

export interface MCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
}

export interface MNode {
  id: string;
  shape: LawhaShape;
  /**
   * Which silhouette, when `shape === "polygon"`. Without this every polygon
   * draws as whatever the emitter's fallback happens to be, which is a bug
   * that looks like a styling choice.
   */
  polygon?: PolygonKind;
  /** Force a square bounding box — a circle is not an oval. */
  square?: boolean;
  /** Draw a second, inset outline (double circle). */
  inset?: boolean;
  label: MLabel;
  /** Present iff `shape === "table"`. */
  table?: MTable;
  style: MStyle;
  /** Subgraph / namespace this belongs to. */
  parentId?: string;
  /** Filled by `layout/measure.ts`. */
  size?: MSize;
  /** Filled by `layout/dagre.ts`. TOP-LEFT — dagre's centres are converted. */
  pos?: MPoint;
  link?: string;
}

export interface MEdge {
  id: string;
  /** Always an id present in `nodes`. See the invariant at the top. */
  from: string;
  to: string;
  label?: MLabel;
  startArrowhead: Arrowhead | null;
  endArrowhead: Arrowhead | null;
  strokeStyle: StrokeStyle;
  strokeWidth: number;
  strokeColor?: string;
  /** dagre rank distance. `A ---> B` is 2. */
  minlen?: number;
  /**
   * Mermaid `~~~`. Fed to dagre so it still influences the layout, but no
   * element is emitted — which is the whole meaning of an invisible link, and
   * what the upstream converter draws as an ordinary solid arrow.
   */
  invisible?: boolean;
  /** Filled by layout. Absolute polyline. */
  points?: MPoint[];
  /**
   * Filled by `layout/measure.ts`. Given to dagre so it reserves room for the
   * label between ranks; without it two near-parallel edges centre their
   * labels on the same point and the text overlaps into one unreadable run.
   */
  labelSize?: MSize;
}

export interface MContainer {
  id: string;
  label: MLabel;
  /** Excalidraw frames cannot nest, so depth decides frame vs rectangle. */
  depth: number;
  parentId?: string;
  childNodeIds: string[];
  childContainerIds: string[];
  style: MStyle;
  size?: MSize;
  pos?: MPoint;
}

/** Something we could not represent. Surfaced, never swallowed. */
export interface MWarning {
  code:
    | "unsupported-shape"
    | "icon-dropped"
    | "image-dropped"
    | "markdown-flattened"
    | "nested-direction-ignored"
    | "static-member-annotated"
    | "unbound-arrow";
  detail: string;
}

export interface MDiagram {
  kind: DiagramKind;
  direction: Direction;
  nodes: MNode[];
  edges: MEdge[];
  containers: MContainer[];
  warnings: MWarning[];
}
