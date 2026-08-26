# 0028 — What a better Mermaid importer costs, and the two ways to buy it

**Status:** partially accepted. The corrections below are **done**; the converter is **proposed** and needs a decision, because both routes to it are larger than they look from outside.

**Affects (done):** `packages/excalidraw/locales/en.json`, `packages/excalidraw/components/TTDDialog/MermaidToExcalidraw.tsx`, `packages/excalidraw/mermaid.ts`, `packages/excalidraw/tests/__snapshots__/MermaidToExcalidraw.test.tsx.snap`.

## Context

The ask was "take everything into consideration and render it better than Excalidraw does". Four facts found while scoping it change what that costs, and three of them contradict what the documentation says. They are recorded here because each one was expensive to establish and would be expensive to establish again.

### 1. Five diagram types convert natively, not three and not four

`node_modules/@excalidraw/mermaid-to-excalidraw/dist/parseMermaid.js:89-116` dispatches on `diagram.type` to five dedicated parsers: `flowchart-v2`/`graph`, `sequence`, `class`/`classDiagram`, `er`, and `state`/`stateDiagram`. Everything else — and, via a `try/catch` around the whole switch, any of those five that throws — becomes `convertSvgToGraphImage`: a base64 SVG data URL wrapped in **one `image` element** (`dist/converter/types/graphImage.js`).

The package README says flowcharts only. DeepWiki says three. **The app's own disclaimer said four and omitted State**, so a feature that works was documented as not working. That string is fixed, and the `<Trans>` wiring it needed — there was no `stateLink` to render — is added.

### 2. Mermaid cannot run under jsdom, which is why nothing tests it

Probed directly rather than assumed:

```
parseMermaidToExcalidraw("flowchart TD\n A[Hi] --> B[There]")
  → TypeError: text2.getBBox is not a function
```

Mermaid renders into a hidden off-screen `<div>` and every parser then scrapes coordinates back out of the live SVG DOM — `getBBox()` and accumulated `transform="translate(...)"` (`parser/flowchart.js:213-246`, `dist/utils.js:108-194`). jsdom implements neither.

This explains the coverage gap rather than excusing it: **every Mermaid test in the repo mocks `parseMermaidToExcalidraw`** (`tests/helpers/mocks.ts:26-51`), no test parses a real diagram of any type, and the image-fallback path has no coverage at all.

> **Amended 2026-08-25, and the amendment reverses the conclusion this section originally drew.** The heading is still true of the UPSTREAM importer and false as a general claim, which is exactly the kind of overreach worth recording rather than quietly editing.
>
> **Mermaid PARSES without a DOM. Only rendering needs one.** `getBBox` is reached from `mermaid.render()`, which the upstream package calls and route B never does. Probed directly: `mermaid.mermaidAPI.getDiagramFromText(text)` returns a fully populated `db` for **all 24 built-in diagram types** in plain node, in about 200ms cold, with no jsdom and no layout loaders. The only blocker is `dompurify`, which needs three properties on `globalThis.window` (`document.nodeType === 9`, `document.createElement`, and an `Element` with a prototype) before it will do anything but return an inert stub — and under the repo's existing jsdom test environment that is already satisfied, so no shim is needed in vitest at all.
>
> `mermaid.initialize({ startOnLoad: false })` IS mandatory first: it is what calls the internal `addDiagrams()` that registers the diagram detectors, and without it every input throws `UnknownDiagramError`.
>
> So the original conclusion — "unmocked round-trip tests in vitest are not possible, real coverage has to be Playwright" — was wrong, and wrong in the expensive direction: it would have sent the whole converter's test suite into a browser it does not need. `excalidraw-app/lawha/mermaid/index.test.ts` now parses real flowcharts and class diagrams, lays them out, converts them to elements and asserts the bindings, entirely in vitest.

What survives unchanged is the diagnosis of the coverage gap: **every Mermaid test in the repo mocks `parseMermaidToExcalidraw`** and the image-fallback path has none. Playwright is still the right home for real font metrics, the dialog preview, drag-to-reroute, and the image fallback — but not for the converter's own logic.

### 3. The semantics are already gone at every seam we can reach

This is the one that decides the architecture. The plan was a Lawha-side layer over the package, routing class and ER diagrams to native `table` elements — a UML class box _is_ a table, and one table element that moves and resizes as one object is a strictly better artefact than the loose scraped rectangles, lines and text that 805 lines of `converter/types/class.js` currently emit.

That layer cannot be written. `parseMermaid` — the only seam below the public `parseMermaidToExcalidraw` — already returns the diagram **decomposed into primitives**:

```ts
export interface Class {
  type: "class";
  nodes: Array<Node[]>;
  lines: Line[];
  arrows: Arrow[];
  text: Text[];
  namespaces: NamespaceNode[];
}
```

There is no class name, no attribute list, no method list. The same is true of `ERD`. By the time anything we can import has run, the structure a table would be built from has been flattened into rectangles. Every fidelity fix is in the same position — the missing `CYLINDER` case, dashed-versus- dotted, the hardcoded `fillStyle: "solid"`, the regex that deletes FontAwesome icons — all of it lives inside compiled `dist/` we do not control.

### 4. `mermaid` is present but undeclared

`node_modules/mermaid@11.12.2` exists only as a transitive dependency of the converter. Nothing in any `package.json` names it, so importing it directly relies on hoisting — which works today and is not a thing to build on without declaring it.

## The two routes

**A — vendor the converter.** Copy the package into the tree and fix it in place. Everything above becomes editable immediately, and the five existing types keep working while they are improved. Cost: roughly 3,000 lines of somebody else's code enters a fork that counts its divergence in individual files, and it is code with no tests we can run (see 2). Upstream fixes stop arriving.

**B — write a Lawha converter on `mermaid` directly.** Declare `mermaid` in `excalidraw-app/package.json`, call `getDiagramFromText` for `diagram.db` — where `getClasses()`, `getEntities()` and the rest still hold full semantics — and render for geometry. Cost: a parser per diagram type, and the geometry half is still browser-only. The gain is that the **semantic** half becomes pure data-to-skeleton mapping, which is unit-testable without a browser and is where every fidelity bug actually lives. It also lands in `excalidraw-app/lawha/`, which upstream does not have and never will, so it costs nothing at merge time — the distinction known issue 20 draws.

**Recommendation: B**, and it depends on ADR 0027's sibling work — `convertToExcalidrawElements` now emits `table`, `tensor` and `code`, which is exactly what a class-diagram-to-table converter needs and what nothing could do before.

## Decision, for now

1. **Done:** the disclaimer names State and links it; the paste heuristic in `mermaid.ts` covers `architecture`, `packet`, `radar`, `treemap` and `kanban`, which shipped in Mermaid 11 and were never added — pasting one produced a text element per line instead of the diagram. Pinned by two new cases in `mermaid.test.ts`, which needs no browser because the heuristic is a regex.
2. **Route B chosen and started.** `mermaid` and `dagre-d3-es` are declared in `excalidraw-app/package.json` with descriptors matching the existing `yarn.lock` entries, so nothing about the lockfile changes. The converter lives in `excalidraw-app/lawha/mermaid/`, which upstream does not have and never will.

   Built so far: **flowchart, class, ER and state**, end to end — parse → intermediate model → dagre layout → skeletons → real elements. **A class and an ER entity each become ONE native `table` element**, which is the thing this ADR exists to make possible. Pinned by 21 tests, none of which touch a browser.

   Only **sequence** still falls through, and the upstream package converts it natively, so nothing regresses — the fallback is a narrowing set, not a hole.

   Fidelity already recovered against the upstream converter: `cylinder` and `subroutine` no longer collapse to unrecognised rectangles, `~~~` is honoured as invisible rather than drawn as a solid arrow, dotted is distinguished from dashed, and `fillStyle` is left unset unless a fill was actually asked for.

   Not built: sequence (its own lifeline layout — genuinely a separate project) and the mermaid 11 `@{shape:}` family. Each is additive, which is the point of the intermediate model.

   **Three defects the build surfaced that no design review would have.** dagre cannot RANK an edge that touches a cluster, and state transitions legitimately point at composite states (`Idle --> Working`) — it dies on `Cannot set properties of undefined`; layout now ranks against a proxy child while the emitted arrow still binds to the container. mermaid returns subgraphs **innermost-first**, so emitting them in its order draws a parent on top of its own child. And an edge label needs its box handed to dagre or two near-parallel transitions centre their labels on the same point and render as one unreadable run — which is exactly what `start` and `done` did until they were measured.

3. **One more `packages/` change, and it is upstream-general.** An arrow could not bind to a `table`, `tensor`, `code`, `image` or `frame`: `transform.ts`'s binding switch constructs only `rectangle`/`ellipse`/`diamond` and `assertNever`s the rest, after which `bindBindingElement` is handed `undefined`. The fix is additive — an existing element is usable as a binding target whatever its type — and the upstream cases are untouched. Without it a class diagram's arrows point at its tables without attaching to them.

## Consequences

- **`TTDDialog/` was pristine upstream as a directory and no longer is.** Measured against `git merge-base upstream/master main`, not recalled. `packages/` went from **63 tracked paths / 9,444 insertions** to **71 / 10,456** once `mermaidLib.ts` was committed — the figure at the time of writing said 70 / 10,419 and counted it as "one new untracked file", which is what `git diff` reports for a path it has never seen. Corrected here rather than left standing, because this repository's rule is to measure the divergence and never recall it, and a number written down before the commit is a recollection. The seven newly-diverged tracked paths are `element/src/transform.ts`, `element/src/__tests__/transform.test.ts`, `excalidraw/mermaid.ts`, `excalidraw/mermaid.test.ts`, `excalidraw/components/TTDDialog/MermaidToExcalidraw.tsx`, `excalidraw/components/TTDDialog/TTDDialog.tsx` and the regenerated `MermaidToExcalidraw.test.tsx.snap`; the new file is `excalidraw/components/TTDDialog/mermaidLib.ts`.

  **Where they land matters more than the count** (known issue 20's own argument). `mermaidLib.ts` is a file upstream does not have, so it costs nothing at merge. `transform.ts` and `TTDDialog.tsx` are pure additions. `App.tsx` — the expensive one — gains exactly two lines: an import and a changed expression. Everything else the converter needs lives in `excalidraw-app/lawha/mermaid/`, which upstream will never have.

- **A visual baseline moves.** The mermaid dialog's description text changed, so the snapshot in `MermaidToExcalidraw.test.tsx.snap` was regenerated — with the diff read: the only change is the State link appearing between Class and Entity Relationship.
- **The image fallback is still untested**, and after this change it is reachable from more inputs than before, because five more keywords now route a paste into the converter. The risk is bounded — the worst case is an image where there used to be plain text — but it is the kind of thing the Playwright suite should cover before anyone claims it is covered.
