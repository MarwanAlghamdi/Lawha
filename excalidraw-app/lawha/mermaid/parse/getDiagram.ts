/**
 * LAWHA: mermaid source text -> a parsed diagram and its database.
 *
 * `diagram.db` is where the semantics live — `getVertices()`, `getClasses()`,
 * `getEntities()`. The upstream converter cannot reach them: by the time its
 * only importable seam returns, a class diagram has already been flattened
 * into rectangles and line segments (ADR 0028 §3). This is the entire reason
 * route B exists.
 */

import { MermaidParseError, UnsupportedDiagramError } from "../errors";

import { loadMermaid } from "./loadMermaid";

import type { DiagramKind } from "../model/types";

/** mermaid's own type ids, mapped to the kinds we convert natively. */
const NATIVE_KINDS: Record<string, DiagramKind> = {
  "flowchart-v2": "flowchart",
  flowchart: "flowchart",
  graph: "flowchart",
  class: "class",
  classDiagram: "class",
  er: "er",
  erDiagram: "er",
  state: "state",
  stateDiagram: "state",
  "stateDiagram-v2": "state",
};

export interface ParsedDiagram {
  kind: DiagramKind;
  /** mermaid's own id, kept for error messages and warnings. */
  mermaidType: string;
  /** Untyped on purpose: each `model/from*.ts` narrows it to the db it knows. */
  db: any;
}

export const getDiagram = async (
  definition: string,
): Promise<ParsedDiagram> => {
  const mermaid = await loadMermaid();

  let diagram: any;
  try {
    diagram = await (mermaid as any).mermaidAPI.getDiagramFromText(definition);
  } catch (error: any) {
    // A diagram type mermaid does not know at all reads as a parse failure,
    // but it is really "not a diagram" — let the caller fall back rather than
    // report a syntax error at line 1 of something that has no syntax error.
    if (error?.name === "UnknownDiagramError") {
      throw new UnsupportedDiagramError("unknown");
    }
    throw new MermaidParseError(String(error?.message ?? error), error?.hash);
  }

  const mermaidType = String(diagram?.type ?? "unknown");
  const kind = NATIVE_KINDS[mermaidType];
  if (!kind) {
    throw new UnsupportedDiagramError(mermaidType);
  }

  // Read `db` exactly once. `flowDiagram.ts` declares it as a getter that
  // constructs a fresh `FlowDB` — reading it twice would hand two different
  // halves of the code two different, both-empty databases.
  const db = diagram.db;
  if (!db) {
    throw new MermaidParseError(
      `mermaid returned no database for ${mermaidType}`,
    );
  }

  return { kind, mermaidType, db };
};
