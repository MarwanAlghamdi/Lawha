/**
 * LAWHA: install the Mermaid converter at app start.
 *
 * A side-effect module, imported once from `index.tsx`, so nothing in
 * `packages/` has to know Lawha exists. The loader itself is lazy — mermaid
 * and dagre stay in their own chunk and are fetched only when somebody
 * actually converts a diagram (ADR 0016 is satisfied trivially: both are
 * bundled with the app, nothing is fetched from anywhere).
 */

import { setMermaidToExcalidrawLoader } from "@excalidraw/excalidraw/components/TTDDialog/mermaidLib";

setMermaidToExcalidrawLoader(async () => {
  const { lawhaMermaidLoader } = await import("./bridge");
  return lawhaMermaidLoader();
});
