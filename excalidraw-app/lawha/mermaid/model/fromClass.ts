/**
 * LAWHA: mermaid's ClassDB -> the intermediate model, as native tables.
 *
 * This is the point of route B. A UML class box IS a table — a name header,
 * then attributes, then methods — and Lawha has a native `table` element that
 * moves, resizes, rotates and undoes as one object.
 *
 * The upstream converter cannot do this. Its only importable seam already
 * returns the diagram flattened into `nodes`/`lines`/`arrows`/`text`, with the
 * class name and member lists gone (ADR 0028 §3). Reading `db` directly is the
 * whole difference.
 *
 * Single column, deliberately: `newTableElement` always writes `even(cols)`,
 * so a multi-column table forces every column to the widest one's width and a
 * column under `MIN_LEGIBLE_WIDTH` silently drops its text. One column makes
 * `even(1) === [1]` and the problem unrepresentable. It is also the correct
 * UML reading — a class compartment is one column.
 */

import type { Arrowhead } from "@excalidraw/element/types";

import { mergeStyles, parseDeclarations } from "./styles";
import { labelText } from "./text";

import type { ConverterOptions } from "../options";
import type { MCell, MDiagram, MEdge, MNode, MWarning } from "./types";

/**
 * mermaid's relation types, by their numeric enum values.
 *
 * The arrowless end is the literal STRING `"none"`, not a number, so every
 * lookup has to check the type before indexing or it silently reads index
 * `undefined` and draws the wrong head.
 */
const RELATION_ARROWHEAD: Record<number, Arrowhead> = {
  0: "diamond_outline", // AGGREGATION
  1: "triangle_outline", // EXTENSION — UML generalisation
  2: "diamond", // COMPOSITION
  3: "arrow", // DEPENDENCY
  4: "circle_outline", // LOLLIPOP
};

const arrowheadFor = (type: unknown): Arrowhead | null =>
  typeof type === "number" ? RELATION_ARROWHEAD[type] ?? null : null;

const asEntries = <T>(value: any): [string, T][] => {
  if (!value) {
    return [];
  }
  return typeof value.entries === "function"
    ? Array.from(value.entries() as Iterable<[string, T]>)
    : Object.entries(value as Record<string, T>);
};

/**
 * A member's text.
 *
 * ALWAYS `getDisplayDetails().displayText`, never `.text`: the raw field is
 * the escaped source (`"\\+dist(Point~T~ other) : double"`). `cssStyle` is how
 * mermaid reports abstract (italic) and static (underline).
 */
const memberCell = (
  member: any,
  warnings: MWarning[],
  owner: string,
): MCell => {
  const details =
    typeof member?.getDisplayDetails === "function"
      ? member.getDisplayDetails()
      : { displayText: String(member?.text ?? member ?? ""), cssStyle: "" };

  const css = String(details?.cssStyle ?? "");
  let text = labelText(details?.displayText);

  if (css.includes("underline")) {
    // A table cell has align/verticalAlign/bold/italic and nothing else, so
    // there is no underline to set. UML's own `{static}` annotation is the
    // honest fallback, and it is stated rather than dropped.
    text = `${text} {static}`;
    warnings.push({
      code: "static-member-annotated",
      detail: `${owner}.${text} is static; written as {static} because a cell has no underline`,
    });
  }

  return {
    text,
    italic: css.includes("italic") || undefined,
    align: "left",
  };
};

export const fromClass = (db: any, options: ConverterOptions): MDiagram => {
  void options;
  const warnings: MWarning[] = [];
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];

  const classDefs = new Map(asEntries<any>(db.getClasses?.()));

  for (const [key, node] of classDefs) {
    const id = String(node?.id ?? key);
    const generic = node?.type ? `<${labelText(node.type)}>` : "";
    const header: MCell[] = [
      {
        text: `${labelText(node?.label ?? id)}${generic}`,
        align: "center",
      },
    ];

    const rows: MCell[][] = [];

    // Every annotation, not just the first. Mermaid's own renderer drops the
    // rest; keeping them loses nothing and surprises nobody.
    for (const annotation of node?.annotations ?? []) {
      rows.push([
        { text: `«${labelText(annotation)}»`, align: "center", italic: true },
      ]);
    }
    for (const member of node?.members ?? []) {
      rows.push([memberCell(member, warnings, id)]);
    }
    for (const method of node?.methods ?? []) {
      rows.push([memberCell(method, warnings, id)]);
    }

    nodes.push({
      id,
      shape: "table",
      label: { text: labelText(node?.label ?? id) },
      table: { header, rows, cols: 1 },
      style: mergeStyles(parseDeclarations(node?.styles ?? [])),
    });
  }

  const known = new Set(nodes.map((node) => node.id));

  const relations: any[] = Array.from(db.getRelations?.() ?? []);
  relations.forEach((relation, index) => {
    const from = String(relation?.id1 ?? "");
    const to = String(relation?.id2 ?? "");
    if (!known.has(from) || !known.has(to)) {
      warnings.push({
        code: "unbound-arrow",
        detail: `relation ${from} -> ${to} names a class that does not exist`,
      });
      return;
    }

    const spec = relation?.relation ?? {};
    const title = labelText(relation?.title);

    edges.push({
      id: `rel-${index}-${from}-${to}`,
      from,
      to,
      label: title && title !== "none" ? { text: title } : undefined,
      startArrowhead: arrowheadFor(spec.type1),
      endArrowhead: arrowheadFor(spec.type2),
      // lineType 1 is DOTTED_LINE. UML realization and dependency are DASHED;
      // mapping them to Excalidraw's "dotted" reads as a different notation.
      strokeStyle: spec.lineType === 1 ? "dashed" : "solid",
      strokeWidth: 2,
      minlen: 1,
    });
  });

  return {
    kind: "class",
    direction: "TB",
    nodes,
    edges,
    containers: [],
    warnings,
  };
};
