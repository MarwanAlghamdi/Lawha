# 0030 — A tensor draws every axis it has, and both renderers read one layout

**Status:** accepted. **Amends [0026](0026-native-grid-elements.md).**

**Affects:** `packages/element/src/{tensorElement,types,newElement}.ts`; `packages/excalidraw/renderer/{lawhaSvg,staticSvgScene}.ts`; `packages/excalidraw/data/restore.ts`.

## Context

`ExcalidrawTensorElement.dims` has been `readonly number[]` since 0026 made the tensor a native element. The type was N-dimensional from the start. The _drawing_ was not:

```ts
const [depth, height, width] = element.dims; // tensorElement.ts
const [depth, height, width] = element.dims; // lawhaSvg.ts, again
```

Three entries, destructured, in two files. So `[8, 64, 32, 32]` — a batch of feature maps, which is most of what anyone draws a tensor for — was rendered by treating the batch size as the depth axis and **silently discarding the trailing 32**. On the canvas it was indistinguishable from `[8, 64, 32]`. Nothing warned, nothing failed, and the shape in the properties panel still read `8 × 64 × 32 × 32`, so the element told you one thing and drew another.

At the other end, `[512]` fell into the flat branch and destructured `[rows, cols]` from a one-element array. `cols` was `undefined`, `String(undefined ?? "")` is `""`, and the renderer drew an empty string at a real coordinate — a `<text>` node with no content in every SVG export of a vector.

Two more things were wrong and had been for as long:

**`edgeLengths` was a no-op at its only call site.** `tensorGeometry` computed the isometric lean with `edgeLengths([dims[0]!], …)`. With a one-element array the largest root is that element's own root, so the ratio is 1 by construction and the result is `longest` whatever the input was. `[2, 64, 32]` and `[512, 64, 32]` drew a pixel-identical box, under a docstring explaining the square-root compression that was not happening.

**The face alphas were computed by index arithmetic that only worked for a shape count of 1 or 3.** `const offset = shapes.length - TENSOR_FACE_ALPHAS.length` — copied verbatim into `staticSvgScene.ts`, so the two had to be edited in lockstep.

None of this was caught, and the reason is worth stating: **every tensor fixture in the repository was 3-D.** `lawhaSvgExport.test.ts` pinned `[64, 32, 16]` and stayed green through all of it. The only test file for `tensorElement.ts` covered `parseDims` and nothing else.

## Decision

**Rank is read by one function, and rendered by dispatching on it.**

| rank | read as                           | drawn as                      |
| ---- | --------------------------------- | ----------------------------- |
| 1    | `[n]`                             | a rectangle, one label        |
| 2    | `[rows, cols]`                    | a flat rectangle              |
| 3    | `[depth, height, width]`          | an isometric box              |
| ≥4   | `[...lead, depth, height, width]` | that box, as a receding stack |

`tensorLayout(element)` performs the split and is the only place that does. No call site destructures `dims`.

### The stack is a symbol, not a count

Two ghost copies stand behind the front box at rank ≥ 4, whether the leading axes multiply out to 8 or to 8,192. The numbers are carried by a multiplier label above the stack — `8 ×`, or `2 × 8 ×` at rank 5.

A stack whose depth tracked the batch size would be one box at `[1, …]`, which is not a stack and would read as rank 3, and an unreadable smear at `[512, …]`. This is the same reasoning that already governs `edgeLengths`: a figure has to say "this is repeated, this many times", and it cannot say the second half by drawing it.

### One layout, two renderers

`resolveTensorLabels(element)` returns every piece of text and where it goes, in element-local coordinates, with anchors spelled the way SVG spells them. The canvas maps `start`/`middle`/`end` onto `left`/`center`/`right` and iterates; the SVG exporter iterates and knows only how a `dominant-baseline` differs.

The layout used to be carried twice, line for line — the same three anchor formulas, the same `?? ""` fallbacks, a `const gap = 6` standing in for a constant `tensorElement.ts` declared without `export` — with the _geometry_ shared through `tensorGeometry` and the _labels_ not. That asymmetry is the mechanism by which an export drifts from the screen: nothing fails, the two files simply stop agreeing, and only somebody comparing a PNG to a canvas would ever find out.

`tensorShapeAlphas(element)` does the same job for opacity: one entry per shape, derived from the element, replacing the index arithmetic in both files.

### Gutters scale with `fontSize`

They were flat pixel counts while the labels drew at `element.fontSize`, which `transform.ts` and `restore.ts` both accept at any positive value — so a 40px label drew into a 26px gutter and out through the side of the element. They are now stated at `TENSOR_LABEL_FONT_SIZE` and scaled, so the factor is exactly 1 at the default and no shipped drawing moves.

The stack's lean is reserved the same way. Everything drawn stays inside the element's own width and height, which `tensorGeometry`'s test asserts at ranks 1 through 5 — a label outside the bounding box is painted by canvas into its offscreen padding but excluded by `getElementAbsoluteCoords`, hit testing and the export crop, while the unclipped SVG `<g>` draws it anyway. That band is exactly where the two renderers disagree without anything failing.

### Rank is bounded at 8

Not a rendering limit — the drawing is identical at rank 4 and rank 40. It is a limit on the _label_: rank 40 writes thirty-seven numbers across the top of the block. Applied in `parseDims` (both editors) and `sanitizeDims` (the skeleton API), and mirrored in `restore.ts`, which also gained `Number.isFinite` — `Infinity > 0` is true and used to reach the geometry.

## Consequences

- **A rank-3 tensor draws differently in one respect**: the isometric lean now varies with the depth axis, as its docstring always claimed. `[2, 64, 32]` leans less than `[512, 64, 32]`. This is a visible change to existing boards and it is the fix, not a regression.
- **`isVolumetric` now means "the core is a box"**, so it is true for rank 4. The alternative — false for a shape that draws as stacked boxes — would have been a worse lie.
- **`packages/` divergence grows by no new paths.** Measured, not recalled: 71 tracked paths before this decision and 71 after (`git diff --name-status $(git merge-base upstream/master main)..HEAD -- packages/`). Every change lands in a file ADR 0026 already added or edited, so the number that matters — the _edited_ count — does not move either.
- **`TENSOR_SVG_FACE_ALPHAS` is kept but superseded.** It cannot answer "what opacity is shape N" once a tensor emits three faces per layer; it survives as a re-export path so the module's public surface is unchanged.
- **The characterization tests are the deliverable as much as the code is.** 33 of them, covering ranks 1 through 5 at each layer — layout, geometry containment, shape/alpha parity, label text and label placement — plus 4-D and 1-D export cases. The audit that found these defects found them by reading; the reason there was anything to find is that nothing was pinning it.

## Alternatives rejected

**Draw the leading axes as more nested boxes.** A 5-D tensor as a grid of stacks. It reads as a picture of an array rather than of a tensor, and the second axis of repetition has no unambiguous direction left once the isometric lean has taken up-and-right.

**Truncate loudly instead — render three axes and mark the shape as clipped.** Considered because it is a smaller change. Rejected because the truncation was never the _intent_; the element type has said `readonly number[]` since it was introduced, and the properties panel has always accepted and echoed back any rank. Honouring what the type already promised is cheaper than documenting a limitation nobody asked for.
