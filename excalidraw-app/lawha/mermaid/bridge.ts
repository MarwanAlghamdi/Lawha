/**
 * LAWHA: which converter handles a given diagram.
 *
 * The Lawha converter handles what it handles natively and says so by throwing
 * `UnsupportedDiagramError`; everything else falls through to
 * `@excalidraw/mermaid-to-excalidraw` exactly as before.
 *
 * That fallback is not a temporary scaffold, it is the thing that makes this
 * shippable in slices. Wiring the Lawha converter in as a wholesale
 * replacement today would take sequence, ER and state diagrams — which the
 * upstream package converts natively — and demote them to a flat image. Each
 * new `model/from*.ts` narrows the fallback by one type, and nothing regresses
 * on the way.
 */

import { UnsupportedDiagramError } from "./errors";

import { parseMermaidToExcalidraw as lawhaParse } from "./index";

const upstream = () => import("@excalidraw/mermaid-to-excalidraw");

export const parseMermaidToExcalidraw = async (
  definition: string,
  config?: unknown,
) => {
  try {
    const { elements, files } = await lawhaParse(definition);
    return { elements, files };
  } catch (error) {
    if (error instanceof UnsupportedDiagramError) {
      const api = await upstream();
      return api.parseMermaidToExcalidraw(definition, config as any);
    }
    // A real syntax error is the user's, and the dialog's error UI is built
    // around mermaid's own message — so it has to surface, not be retried
    // into a second, differently-worded failure.
    throw error;
  }
};

/** Registered once at app start. */
export const lawhaMermaidLoader = async () => ({ parseMermaidToExcalidraw });
