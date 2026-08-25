/**
 * LAWHA: Mermaid -> Excalidraw, without a browser and without the renderer.
 *
 * The contract matches `@excalidraw/mermaid-to-excalidraw`'s
 * `parseMermaidToExcalidraw` exactly, so this is a drop-in for it.
 *
 * What it does differently, and why it exists (ADR 0028):
 *
 *  - It reads mermaid's **database**, not its rendered SVG, so class diagrams
 *    keep their names, attributes and methods and can become native Lawha
 *    `table` elements instead of a pile of scraped rectangles.
 *  - It runs its own dagre layout with OUR node sizes, because ours differ
 *    from mermaid's and scraped coordinates would be spaced for the wrong boxes.
 *  - It never calls `mermaid.render`, so it needs no DOM — which is why every
 *    layer of it is unit-testable, and the upstream one is not testable at all.
 */

import { convertToExcalidrawElements } from "@excalidraw/element";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import { UnsupportedDiagramError } from "./errors";
import { toSkeletons } from "./emit/toSkeleton";
import { layoutDiagram } from "./layout/dagre";
import { measureDiagram } from "./layout/measure";
import { fromClass } from "./model/fromClass";
import { fromEr } from "./model/fromEr";
import { fromState } from "./model/fromState";
import { fromFlowchart } from "./model/fromFlowchart";
import { withDefaults } from "./options";
import { getDiagram } from "./parse/getDiagram";

import type { ConverterOptions } from "./options";
import type { MDiagram, MWarning } from "./model/types";

export { UnsupportedDiagramError, MermaidParseError } from "./errors";
export type { MDiagram } from "./model/types";

export interface LawhaMermaidResult {
  elements: ExcalidrawElementSkeleton[];
  files: Record<string, never>;
  warnings: MWarning[];
}

/** Source text -> the positioned intermediate model. Exported for tests. */
export const buildModel = async (
  definition: string,
  options?: Partial<ConverterOptions>,
): Promise<{ diagram: MDiagram; options: ConverterOptions }> => {
  const resolved = withDefaults(options);
  const { kind, db } = await getDiagram(definition);

  let diagram: MDiagram;
  switch (kind) {
    case "flowchart":
      diagram = fromFlowchart(db, resolved);
      break;
    case "class":
      diagram = fromClass(db, resolved);
      break;
    case "er":
      diagram = fromEr(db, resolved);
      break;
    case "state":
      diagram = fromState(db, resolved);
      break;
    default:
      throw new UnsupportedDiagramError(kind);
  }

  return {
    diagram: layoutDiagram(measureDiagram(diagram, resolved), resolved),
    options: resolved,
  };
};

export const parseMermaidToExcalidraw = async (
  definition: string,
  options?: Partial<ConverterOptions>,
): Promise<LawhaMermaidResult> => {
  const { diagram, options: resolved } = await buildModel(definition, options);
  return {
    elements: toSkeletons(diagram, resolved),
    files: {},
    warnings: diagram.warnings,
  };
};

/** The whole pipeline, ending in real elements. This is what a caller inserts. */
export const mermaidToExcalidrawElements = async (
  definition: string,
  options?: Partial<ConverterOptions>,
) => {
  const { elements, warnings } = await parseMermaidToExcalidraw(
    definition,
    options,
  );
  return {
    elements: convertToExcalidrawElements(elements, { regenerateIds: false }),
    warnings,
  };
};
