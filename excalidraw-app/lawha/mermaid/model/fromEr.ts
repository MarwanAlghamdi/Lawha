/**
 * LAWHA: mermaid's ErDB -> the intermediate model, as native tables.
 *
 * An ER entity is a table in the most literal sense available — a name and a
 * list of typed attributes — so this reuses the whole `shape: "table"` path
 * that `fromClass.ts` established and adds only the cardinality arrowheads.
 *
 * Two traps, both verified against a real parse rather than the .d.ts:
 *
 *  1. **`getEntities()` is keyed by NAME, `getRelationships()` references
 *     `EntityNode.id`.** `CUSTOMER` versus `entity-CUSTOMER-0`. Looking a
 *     relationship's endpoints up in the entity map directly finds nothing,
 *     and every arrow silently disappears.
 *  2. **The cardinalities are swapped relative to the endpoints.**
 *     `CUSTOMER ||--o{ ORDER` reports `cardA: ZERO_OR_MORE, cardB: ONLY_ONE`
 *     — `cardA` describes the entityB end and `cardB` the entityA end. Getting
 *     this backwards produces a diagram that is confidently, readably wrong,
 *     which is worse than one that fails.
 */

import type { Arrowhead } from "@excalidraw/element/types";

import { labelText } from "./text";

import type { ConverterOptions } from "../options";
import type { MCell, MDiagram, MEdge, MNode, MWarning } from "./types";

/**
 * Mermaid's five cardinalities onto Excalidraw's six crow's-foot arrowheads.
 *
 * This is the one place upstream fidelity is already perfect, and it is worth
 * keeping: Excalidraw genuinely ships ER notation, so an entity relationship
 * diagram converts to something that still reads as one.
 */
const CARDINALITY: Record<string, Arrowhead | null> = {
  ONLY_ONE: "cardinality_exactly_one",
  ZERO_OR_ONE: "cardinality_zero_or_one",
  ONE_OR_MORE: "cardinality_one_or_many",
  ZERO_OR_MORE: "cardinality_zero_or_many",
  // Markdown-parent. Mermaid draws nothing for it either.
  MD_PARENT: null,
};

const asValues = <T>(value: any): T[] => {
  if (!value) {
    return [];
  }
  return typeof value.values === "function"
    ? Array.from(value.values() as Iterable<T>)
    : Object.values(value as Record<string, T>);
};

/** `PK,FK  string name  — the comment`, which is how an ER row reads. */
const attributeRow = (attribute: any): MCell => {
  const keys: string[] = Array.isArray(attribute?.keys) ? attribute.keys : [];
  const prefix = keys.length ? `${keys.join(",")}  ` : "";
  const type = labelText(attribute?.type);
  const name = labelText(attribute?.name);
  const comment = labelText(attribute?.comment);
  return {
    text: `${prefix}${type} ${name}${comment ? `  — ${comment}` : ""}`.trim(),
    align: "left",
    // A key attribute is the one a reader looks for first.
    bold: keys.length > 0 || undefined,
  };
};

export const fromEr = (db: any, options: ConverterOptions): MDiagram => {
  void options;
  const warnings: MWarning[] = [];
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];

  const entities = asValues<any>(db.getEntities?.());

  // Trap 1. Build the id index BEFORE anything looks a relationship up.
  const byId = new Map<string, any>(
    entities.map((entity) => [String(entity?.id), entity]),
  );

  for (const entity of entities) {
    const id = String(entity?.id);
    const title = labelText(entity?.alias) || labelText(entity?.label) || id;
    const header: MCell[] = [{ text: title, align: "center" }];
    const rows: MCell[][] = (entity?.attributes ?? []).map((attribute: any) => [
      attributeRow(attribute),
    ]);

    nodes.push({
      id,
      shape: "table",
      label: { text: title },
      table: { header, rows, cols: 1 },
      style: {},
    });
  }

  const relationships: any[] = Array.from(db.getRelationships?.() ?? []);
  relationships.forEach((relation, index) => {
    const from = String(relation?.entityA ?? "");
    const to = String(relation?.entityB ?? "");
    if (!byId.has(from) || !byId.has(to)) {
      warnings.push({
        code: "unbound-arrow",
        detail: `relationship ${from} -> ${to} names an entity that does not exist`,
      });
      return;
    }

    const spec = relation?.relSpec ?? {};
    // Trap 2. cardB is the entityA end; cardA is the entityB end.
    const startArrowhead = CARDINALITY[String(spec.cardB)] ?? null;
    const endArrowhead = CARDINALITY[String(spec.cardA)] ?? null;

    if (spec.cardA === "MD_PARENT" || spec.cardB === "MD_PARENT") {
      warnings.push({
        code: "unbound-arrow",
        detail: `relationship ${from} -> ${to} uses MD_PARENT, which has no crow's-foot notation`,
      });
    }

    const role = labelText(relation?.roleA);

    edges.push({
      id: `er-${index}-${from}-${to}`,
      from,
      to,
      label: role && role !== "none" ? { text: role } : undefined,
      startArrowhead,
      endArrowhead,
      // A non-identifying relationship is drawn dashed, which is the notation
      // carrying real meaning rather than decoration.
      strokeStyle: spec.relType === "NON_IDENTIFYING" ? "dashed" : "solid",
      strokeWidth: 2,
      minlen: 1,
    });
  });

  return {
    kind: "er",
    direction: "TB",
    nodes,
    edges,
    containers: [],
    warnings,
  };
};
