import { isMaybeMermaidDefinition } from "./mermaid";

describe("isMaybeMermaidDefinition", () => {
  it("should return true for a valid mermaid definition", () => {
    expect(isMaybeMermaidDefinition("flowchart")).toBe(true);
    expect(isMaybeMermaidDefinition("flowchart LR")).toBe(true);
    expect(isMaybeMermaidDefinition("flowchart LR\nola")).toBe(true);
    expect(isMaybeMermaidDefinition("%%{}%%flowchart")).toBe(true);
    expect(isMaybeMermaidDefinition("%%{}%% flowchart")).toBe(true);

    expect(isMaybeMermaidDefinition("graphs")).toBe(false);
    expect(isMaybeMermaidDefinition("this flowchart")).toBe(false);
    expect(isMaybeMermaidDefinition("this\nflowchart")).toBe(false);
  });

  // LAWHA: these four shipped in Mermaid 11 and were never added to the list,
  // so pasting one onto the canvas produced a text element per line instead of
  // the diagram. The `-beta` suffix matters — that is how several of them are
  // still spelled.
  it("recognises the diagram types Mermaid 11 added", () => {
    expect(isMaybeMermaidDefinition("architecture-beta")).toBe(true);
    expect(isMaybeMermaidDefinition("packet-beta")).toBe(true);
    expect(isMaybeMermaidDefinition("packet")).toBe(true);
    expect(isMaybeMermaidDefinition("radar-beta")).toBe(true);
    expect(isMaybeMermaidDefinition("treemap")).toBe(true);
    expect(isMaybeMermaidDefinition("kanban")).toBe(true);
  });

  it("still anchors at the start, so prose that mentions one is not one", () => {
    expect(isMaybeMermaidDefinition("a radar chart of results")).toBe(false);
    expect(isMaybeMermaidDefinition("the treemap below")).toBe(false);
  });
});
