/**
 * LAWHA: one place that decides which Mermaid converter runs.
 *
 * Both call sites — the TTD dialog and the paste path in `App.tsx` — used to
 * hardcode `import("@excalidraw/mermaid-to-excalidraw")`. A host app therefore
 * had no way to supply its own converter without editing upstream files.
 *
 * The default is unchanged, so an upstream caller that never registers a
 * loader gets exactly the behaviour it had before. Lawha registers one that
 * converts flowcharts and class diagrams natively (ADR 0028) and falls back to
 * this same package for everything else.
 */

import type { MermaidToExcalidrawResult } from "@excalidraw/mermaid-to-excalidraw/dist/interfaces";

export interface MermaidToExcalidrawLib {
  parseMermaidToExcalidraw: (
    definition: string,
    config?: unknown,
  ) => Promise<MermaidToExcalidrawResult>;
}

let loader: (() => Promise<MermaidToExcalidrawLib>) | null = null;

/** Register a converter. Called once, at app start. */
export const setMermaidToExcalidrawLoader = (
  fn: (() => Promise<MermaidToExcalidrawLib>) | null,
) => {
  loader = fn;
};

export const loadMermaidToExcalidraw = (): Promise<MermaidToExcalidrawLib> =>
  loader
    ? loader()
    : (import(
        "@excalidraw/mermaid-to-excalidraw"
      ) as Promise<MermaidToExcalidrawLib>);
