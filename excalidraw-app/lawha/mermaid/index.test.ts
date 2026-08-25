import { convertToExcalidrawElements } from "@excalidraw/element";
import { describe, expect, it, vi } from "vitest";

import { UnsupportedDiagramError } from "./errors";

import { buildModel, parseMermaidToExcalidraw } from "./index";

/**
 * The architecture proof for ADR 0028 route B.
 *
 * Every one of these runs in vitest with NO browser. That is the whole claim:
 * the upstream importer renders to a hidden div and scrapes the SVG, so it
 * cannot be tested at all — every Mermaid test in this repo mocks it, and the
 * real library throws `text2.getBBox is not a function` under jsdom. This one
 * never renders, so all four layers are exercised for real.
 */

const FLOWCHART = `flowchart TD
  A[Start] --> B{Choose}
  B -->|yes| C(Round)
  B -.no.-> D[[Sub]]
  C --> E[(Store)]
`;

const ER = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string name PK "the name"
    int age
  }
  ORDER }|..|{ LINE_ITEM : contains
`;

const STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Working : start
  state Working {
    [*] --> Fetch
    Fetch --> Parse
  }
  Working --> Idle : done
`;

const CLASSES = `classDiagram
  class Animal {
    +String name
    -int age
    +move() void
  }
  class Dog {
    +bark() void
  }
  Animal <|-- Dog
`;

/** `transform.ts` reports binding failures ONLY through console.error. */
const withConsoleErrorSpy = async (run: () => Promise<void> | void) => {
  const seen: unknown[][] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => void seen.push(args));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return seen;
};

describe("the Lawha Mermaid converter", () => {
  it("parses a flowchart with no DOM and no render", async () => {
    const { diagram } = await buildModel(FLOWCHART);

    expect(diagram.kind).toBe("flowchart");
    expect(diagram.direction).toBe("TB");
    expect(diagram.nodes.map((n) => n.id).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(diagram.edges).toHaveLength(4);
  });

  it("maps shapes the upstream converter drops on the floor", async () => {
    const { diagram } = await buildModel(FLOWCHART);
    const shapeOf = (id: string) =>
      diagram.nodes.find((n) => n.id === id)!.shape;

    expect(shapeOf("A")).toBe("rectangle");
    expect(shapeOf("B")).toBe("diamond");
    expect(shapeOf("C")).toBe("rounded");
    // `[[Sub]]` — subroutine. Not in the upstream enum at all.
    expect(shapeOf("D")).toBe("rectangle");
    // `[(Store)]` — cylinder. In the upstream enum with NO case in its switch,
    // so upstream renders a database node as a plain rectangle.
    expect(shapeOf("E")).toBe("rectangle");
  });

  it("distinguishes dotted from solid, which upstream collapses", async () => {
    const { diagram } = await buildModel(FLOWCHART);
    const dotted = diagram.edges.find((e) => e.from === "B" && e.to === "D");
    expect(dotted!.strokeStyle).toBe("dotted");
    const solid = diagram.edges.find((e) => e.from === "A" && e.to === "B");
    expect(solid!.strokeStyle).toBe("solid");
  });

  it("lays out with real geometry and no overlaps", async () => {
    const { diagram } = await buildModel(FLOWCHART);

    for (const node of diagram.nodes) {
      expect(node.pos).toBeDefined();
      expect(node.size!.width).toBeGreaterThan(0);
    }

    // TB: every edge's target starts below its source ends.
    for (const edge of diagram.edges) {
      const from = diagram.nodes.find((n) => n.id === edge.from)!;
      const to = diagram.nodes.find((n) => n.id === edge.to)!;
      expect(to.pos!.y).toBeGreaterThan(from.pos!.y);
    }

    // No two node rectangles overlap.
    const rects = diagram.nodes.map((n) => ({
      l: n.pos!.x,
      t: n.pos!.y,
      r: n.pos!.x + n.size!.width,
      b: n.pos!.y + n.size!.height,
    }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlaps = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("is deterministic — the same source lays out identically", async () => {
    const a = await buildModel(FLOWCHART);
    const b = await buildModel(FLOWCHART);
    expect(a.diagram.nodes.map((n) => n.pos)).toEqual(
      b.diagram.nodes.map((n) => n.pos),
    );
  });

  /** THE architecture proof: all four layers, ending in real elements. */
  it("round-trips to bound Excalidraw elements with no console.error", async () => {
    const { elements: skeletons } = await parseMermaidToExcalidraw(FLOWCHART);

    let elements: any[] = [];
    const errors = await withConsoleErrorSpy(() => {
      elements = convertToExcalidrawElements(skeletons, {
        regenerateIds: false,
      }) as any[];
    });

    // "No element for start binding with id X found", "Duplicate id found" and
    // "Unhandled element start type" are reported ONLY here. A silent one is
    // exactly the failure this asserts against.
    expect(errors).toEqual([]);

    const arrows = elements.filter((el) => el.type === "arrow");
    expect(arrows).toHaveLength(4);
    for (const arrow of arrows) {
      expect(arrow.startBinding?.elementId).toBeTruthy();
      expect(arrow.endBinding?.elementId).toBeTruthy();
    }

    expect(elements.filter((el) => el.type === "diamond")).toHaveLength(1);
  });

  it("turns each class into ONE native table element", async () => {
    const { elements: skeletons } = await parseMermaidToExcalidraw(CLASSES);

    let elements: any[] = [];
    const errors = await withConsoleErrorSpy(() => {
      elements = convertToExcalidrawElements(skeletons, {
        regenerateIds: false,
      }) as any[];
    });
    expect(errors).toEqual([]);

    const tables = elements.filter((el) => el.type === "table");
    expect(tables).toHaveLength(2);

    const animal = tables.find((t) => t.cells[0][0].text.startsWith("Animal"))!;
    // Header, then two members, then one method — the UML compartments.
    const texts = animal.cells.map((row: any[]) => row[0].text);
    expect(texts[0]).toBe("Animal");
    expect(texts.join("\n")).toContain("name");
    expect(texts.join("\n")).toContain("age");
    expect(texts.join("\n")).toContain("move");

    // Single column, which is what keeps `even(cols)` honest.
    expect(animal.colWidths).toEqual([1]);
    expect(animal.headerRow).toBe(true);
    // The class name is centred over left-aligned members — ADR 0027's
    // per-cell alignment, which is why this needed that work first.
    expect(animal.cells[0][0].align).toBe("center");
    expect(animal.cells[1][0].align).toBe("left");
  });

  it("binds a relation arrow to the tables it points at", async () => {
    const { elements: skeletons } = await parseMermaidToExcalidraw(CLASSES);
    const elements = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
    }) as any[];

    const arrow = elements.find((el) => el.type === "arrow")!;
    // `Animal <|-- Dog` puts the generalisation triangle at id1 — Animal, the
    // START. mermaid reports `{type1: 1, type2: "none"}`, and `"none"` is a
    // literal string, not a number: indexing the enum with it without a
    // typeof guard silently yields the wrong head at the wrong end.
    expect(arrow.startArrowhead).toBe("triangle_outline");
    expect(arrow.endArrowhead).toBeNull();
    expect(arrow.startBinding?.elementId).toBeTruthy();
    expect(arrow.endBinding?.elementId).toBeTruthy();
  });

  it("turns each ER entity into a table, keyed by id not by name", async () => {
    // `getEntities()` is keyed by NAME (`CUSTOMER`) while `getRelationships()`
    // references `EntityNode.id` (`entity-CUSTOMER-0`). Looking endpoints up in
    // the entity map directly finds nothing and every arrow vanishes silently.
    const { elements: skeletons } = await parseMermaidToExcalidraw(ER);

    let elements: any[] = [];
    const errors = await withConsoleErrorSpy(() => {
      elements = convertToExcalidrawElements(skeletons, {
        regenerateIds: false,
      }) as any[];
    });
    expect(errors).toEqual([]);

    const tables = elements.filter((el) => el.type === "table");
    expect(tables).toHaveLength(3);

    const customer = tables.find((t) =>
      t.cells[0][0].text.startsWith("CUSTOMER"),
    )!;
    const texts = customer.cells.map((row: any[]) => row[0].text);
    expect(texts[0]).toBe("CUSTOMER");
    // `{type, name, keys, comment}` — NOT the mermaid-10 `attributeType`
    // names, which are jison labels and undefined at runtime.
    expect(texts[1]).toContain("PK");
    expect(texts[1]).toContain("string name");
    expect(texts[1]).toContain("the name");

    // The arrows survived the id lookup.
    const arrows = elements.filter((el) => el.type === "arrow");
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      expect(arrow.startBinding?.elementId).toBeTruthy();
      expect(arrow.endBinding?.elementId).toBeTruthy();
    }
  });

  it("puts each ER cardinality at the correct end", async () => {
    // `CUSTOMER ||--o{ ORDER` means one CUSTOMER, many ORDERs. mermaid reports
    // `cardA: ZERO_OR_MORE, cardB: ONLY_ONE` — cardA describes the entityB end.
    // Reading them straight across produces a diagram that is readable and
    // backwards, which is worse than one that fails.
    const { diagram } = await buildModel(ER);
    const places = diagram.edges.find((e) => e.label?.text === "places")!;

    const from = diagram.nodes.find((n) => n.id === places.from)!;
    const to = diagram.nodes.find((n) => n.id === places.to)!;
    expect(from.label.text).toBe("CUSTOMER");
    expect(to.label.text).toBe("ORDER");

    expect(places.startArrowhead).toBe("cardinality_exactly_one");
    expect(places.endArrowhead).toBe("cardinality_zero_or_many");
    // `||--o{` is identifying.
    expect(places.strokeStyle).toBe("solid");
  });

  it("draws a non-identifying relationship dashed", async () => {
    const { diagram } = await buildModel(ER);
    const contains = diagram.edges.find((e) => e.label?.text === "contains")!;
    // `}|..|{` — non-identifying, and the dashes carry the meaning.
    expect(contains.strokeStyle).toBe("dashed");
    expect(contains.startArrowhead).toBe("cardinality_one_or_many");
    expect(contains.endArrowhead).toBe("cardinality_one_or_many");
  });

  it("draws the shapes the upstream enum has no case for", async () => {
    const { diagram } = await buildModel(`flowchart LR
  H{{hex}} --> T[/trap\\]
  T --> P[/para/]
  P --> C((circ))
  C --> D(((dbl)))
  D --> F>flag]
`);
    const byId = new Map(diagram.nodes.map((n) => [n.id, n]));

    expect(byId.get("H")!.shape).toBe("polygon");
    expect(byId.get("H")!.polygon).toBe("hexagon");
    expect(byId.get("T")!.polygon).toBe("trapezoid");
    expect(byId.get("P")!.polygon).toBe("leanRight");
    expect(byId.get("F")!.polygon).toBe("flag");

    // A circle is not an oval, and a double circle needs two rings.
    expect(byId.get("C")!.shape).toBe("ellipse");
    expect(byId.get("C")!.square).toBe(true);
    expect(byId.get("D")!.inset).toBe(true);
  });

  it("emits a real polygon outline, and a square circle", async () => {
    const { elements } = await parseMermaidToExcalidraw(`flowchart LR
  H{{hex}} --> C((circ))
`);
    const line: any = elements.find((el: any) => el.type === "line");
    expect(line.polygon).toBe(true);
    // Closed: six corners plus the repeated first point.
    expect(line.points).toHaveLength(7);

    const ellipse: any = elements.find((el: any) => el.type === "ellipse");
    expect(ellipse.width).toBe(ellipse.height);
  });

  it("degrades polygons to bindable rectangles when asked", async () => {
    const { diagram } = await buildModel(
      "flowchart LR\n  H{{hex}} --> B[b]\n",
      {
        preferBindableShapes: true,
      },
    );
    // The trade is explicit: silhouette for an arrow that re-routes on drag.
    expect(diagram.nodes.find((n) => n.id === "H")!.shape).toBe("rectangle");
  });

  it("makes a top-level subgraph a frame and a nested one a rectangle", async () => {
    const { diagram } = await buildModel(`flowchart TD
  subgraph outer[Outer]
    subgraph inner[Inner]
      A[a]
    end
    B[b]
  end
  A --> B
`);
    const outer = diagram.containers.find((c) => c.id === "outer")!;
    const inner = diagram.containers.find((c) => c.id === "inner")!;
    expect(outer.depth).toBe(0);
    // Excalidraw frames cannot nest, so depth decides frame vs rectangle.
    expect(inner.depth).toBe(1);
    expect(inner.parentId).toBe("outer");

    const { elements } = await parseMermaidToExcalidraw(`flowchart TD
  subgraph outer[Outer]
    subgraph inner[Inner]
      A[a]
    end
    B[b]
  end
  A --> B
`);
    const frames = elements.filter((el: any) => el.type === "frame");
    expect(frames).toHaveLength(1);
    expect((frames[0] as any).name).toBe("Outer");
    // Containers come first so they land behind their contents.
    expect((elements[0] as any).type).toBe("frame");
  });

  it("sets fillStyle only when a fill was actually asked for", async () => {
    const { diagram } = await buildModel(`flowchart LR
  A[a]:::warm --> B[b]
  classDef warm fill:#ffd8a8,stroke:#e8590c,stroke-width:4px
`);
    const a = diagram.nodes.find((n) => n.id === "A")!;
    const b = diagram.nodes.find((n) => n.id === "B")!;

    expect(a.style.backgroundColor).toBe("#ffd8a8");
    expect(a.style.strokeColor).toBe("#e8590c");
    expect(a.style.strokeWidth).toBe(4);
    expect(a.style.fillStyle).toBe("solid");

    // The bug this guards: upstream sets solid unconditionally, so an
    // unstyled node gets a flat fill on a hand-drawn canvas.
    expect(b.style.fillStyle).toBeUndefined();
    expect(b.style.backgroundColor).toBeUndefined();
  });

  it("honours an invisible link instead of drawing it", async () => {
    const source = "flowchart TD\n  A[a] ~~~ B[b]\n";
    const { diagram } = await buildModel(source);
    expect(diagram.edges).toHaveLength(1);
    expect(diagram.edges[0]!.invisible).toBe(true);

    const { elements } = await parseMermaidToExcalidraw(source);
    // Upstream draws `~~~` as an ordinary solid arrow, which is the opposite
    // of what it means. It still shapes the layout.
    expect(elements.filter((el: any) => el.type === "arrow")).toHaveLength(0);
    const a = diagram.nodes.find((n) => n.id === "A")!;
    const b = diagram.nodes.find((n) => n.id === "B")!;
    expect(b.pos!.y).toBeGreaterThan(a.pos!.y);
  });

  it("keeps composite states, which getStates() would have dropped", async () => {
    // `getStates()`/`getRelations()` read the ROOT document only, so every
    // state nested in a composite is silently missing. `getData()` is already
    // flattened with parentId, which is why this uses it.
    const { diagram } = await buildModel(STATE);

    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("Idle");
    // Both live INSIDE `state Working { ... }`.
    expect(ids).toContain("Fetch");
    expect(ids).toContain("Parse");

    const working = diagram.containers.find((c) => c.id === "Working")!;
    expect(working.label.text).toBe("Working");
    expect(working.childNodeIds).toContain("Fetch");
    expect(working.childNodeIds).toContain("Parse");
  });

  it("draws terminals as marks, not as their generated ids", async () => {
    const { diagram } = await buildModel(STATE);
    const start = diagram.nodes.find((n) => n.id === "root_start")!;

    // mermaid sets `label` to the node's own id, so a converter that trusts it
    // writes the word "root_start" on the canvas.
    expect(start.label.text).toBe("");
    expect(start.shape).toBe("ellipse");
    expect(start.square).toBe(true);
    // A start marker is a filled dot at a fixed size, whatever is near it.
    expect(start.size).toEqual({ width: 18, height: 18 });
    expect(start.style.fillStyle).toBe("solid");

    // A UML state is a rounded box; a square one reads as an activity.
    expect(diagram.nodes.find((n) => n.id === "Idle")!.shape).toBe("rounded");
  });

  it("round-trips a state diagram to bound elements", async () => {
    const { elements: skeletons } = await parseMermaidToExcalidraw(STATE);
    let elements: any[] = [];
    const errors = await withConsoleErrorSpy(() => {
      elements = convertToExcalidrawElements(skeletons, {
        regenerateIds: false,
      }) as any[];
    });
    expect(errors).toEqual([]);

    // The composite state became a frame, and the transitions bound to it.
    expect(elements.filter((el) => el.type === "frame")).toHaveLength(1);
    const arrows = elements.filter((el) => el.type === "arrow");
    expect(arrows.length).toBeGreaterThan(0);
    for (const arrow of arrows) {
      expect(arrow.startBinding?.elementId).toBeTruthy();
      expect(arrow.endBinding?.elementId).toBeTruthy();
    }
    // The labelled transition kept its label.
    expect(
      elements.some((el) => el.type === "text" && el.text === "start"),
    ).toBe(true);
  });

  it("falls back rather than failing for a type it does not convert", async () => {
    await expect(
      parseMermaidToExcalidraw('pie title Votes\n  "A" : 10\n'),
    ).rejects.toBeInstanceOf(UnsupportedDiagramError);
  });
});
