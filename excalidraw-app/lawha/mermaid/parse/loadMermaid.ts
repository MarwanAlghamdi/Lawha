/**
 * LAWHA: load mermaid once, lazily, and initialise it exactly once.
 *
 * Lazy because mermaid plus dagre is the largest thing this app would bundle,
 * and nobody who never opens the Mermaid dialog should pay for it. The dynamic
 * `import()` keeps it in its own chunk.
 *
 * `initialize` is not optional and the reason is not obvious: it is what calls
 * mermaid's internal `addDiagrams()`, which registers the diagram *detectors*.
 * Calling `getDiagramFromText` without it throws `UnknownDiagramError` for
 * every input, including a perfectly valid flowchart.
 *
 * Note what is NOT here: no `mermaid.render`, no layout loader, no DOM
 * requirement. Parsing is pure, which is why this converter is testable and
 * the upstream one — which renders to a hidden div and scrapes the SVG — is
 * not. See docs/adr/0028.
 */

type MermaidModule = typeof import("mermaid").default;

let loading: Promise<MermaidModule> | null = null;

export const loadMermaid = (): Promise<MermaidModule> => {
  if (!loading) {
    loading = import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        // We never render, so a theme would do nothing; `securityLevel` still
        // governs how labels are sanitised on the parse path.
        securityLevel: "strict",
      });
      return mermaid;
    });
  }
  return loading;
};

/** Testing seam: forget the memoised instance. */
export const resetMermaidForTests = () => {
  loading = null;
};
