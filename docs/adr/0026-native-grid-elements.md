# 0026 — Tables, tensors and code blocks are element types

**Status:** accepted. **Supersedes [0023](0023-composed-grid-objects.md) and [0025](0025-code-blocks-render-to-svg.md).**

**Adds to `packages/`.** Divergence goes from 14 files to 63 — 21 added, 42 edited. That is the cost of this decision and the reason this ADR exists rather than a footnote to it.

**Amended 2026-08-18** after a screenshot-led review found the first implementation had bypassed roughjs entirely. See §"The rendering split, corrected" below; the decision to make these native types is unchanged, the way they draw is not.

**Affects:** `packages/element/src/{tableElement,tableElementEditor,tensorElement,codeElement,codeHighlight}.ts` (new); `packages/excalidraw/components/{TableCellEditor,CodeBlockEditor,TensorDimsEditor,LawhaElementActions}.tsx` (new); `packages/excalidraw/renderer/tableHandles.ts` (new); dispatch points in `types.ts`, `typeChecks.ts`, `newElement.ts`, `shape.ts`, `bounds.ts`, `collision.ts`, `distance.ts`, `comparisons.ts`, `renderElement.ts`, `staticSvgScene.ts`, `restore.ts`, `mutateElement.ts`, `scene/types.ts`, `constants.ts`, `Tools.tsx`, `Toolbar.tsx`, `Actions.tsx`, `icons.tsx`, `locales/en.json`, `App.tsx`. Deletes `excalidraw-app/lawha/{table,dataviz,code}/*`.

## Context

0023 chose composition — a table was a pile of rectangles and text elements tagged through `customData`, held together by a DOM overlay — and set an explicit bar for reopening the decision: **observed data loss**. That bar was not met. This ADR is being written anyway, and it is worth being honest about why.

The trigger was a **UX judgement**, not a bug report. The composed objects worked in the sense that they appeared on the canvas and persisted. They failed in the sense that they were not objects:

- **Cells overlapped when resized, and could not be resized at all.** `tableSnap.ts` modelled the grid as a single scalar pair `{ cellWidth, cellHeight }` — uniform cell size was baked into the type, so a wider cell was unrepresentable. `snapStrayCells` wrote back only `x`/`y`, never `width`, so widening one cell overlapped its neighbour and dragging its left edge teleported it back while keeping the new width.
- **Bulk cells could not be dragged.** The row and column anchors were `<button onClick>` with no pointer handlers, and `snapAllTables` on the next pointer-up actively _undid_ any multi-cell drag by outvoting the moved cells.
- **A double-click on a code block entered image cropping**, because a code block was an image.
- **A 3-D tensor was three planes and three texts in a group.** Moving it moved a group. Undoing its creation was six undos. Selecting it selected a group and then, on the second click, one plane.

None of these is a bug in the composition; they are the composition. A table whose geometry no element owns cannot have its geometry edited, and a group is not a thing however tightly you tie it.

## The reason 0023 said no is real, and is answered first

0023's argument was not weak. `restore.ts` had a `switch (element.type)` with **no `default`**, so an element of an unknown type fell through to `return null` and `restoreElements` filtered it out. `restoreElements` runs on initial data, on every scene load from lawha-server, on file open, on paste, on library insert, and — via `excalidraw-app/data/storage/lawha.ts` — on **remote** elements before reconciliation. The sequence for a client that did not know the type was: load the board, silently drop every table, save the scene back with the tables gone. Three further passes (`repairContainerElement`, `repairFrameMembership`, and the renderer's `throw new Error("Unimplemented type")`) made partial survival worse than deletion.

That is answered directly, and **before** any new type was added, in commit `c293d0c3`:

| File | Was | Is |
| --- | --- | --- |
| `data/restore.ts` | falls through to `return null` | `default:` preserves the element via `restoreElementWithProperties`, which already spreads the original for forward-compat |
| `element/renderElement.ts` (×2) | `throw new Error("Unimplemented type")` | dashed placeholder at 0.5 alpha |
| `element/shape.ts` | `assertNever` | `return null` — already the semantically correct value for "draws itself" |
| `element/shape.ts`, `distance.ts`, `collision.ts` | no `default`, silently `undefined` | fall through to the rectanguloid path, so hit-testing degrades to "it's a box" |
| `renderer/staticSvgScene.ts` | `throw` | placeholder `<rect>` |

Six tests pin it (`tests/data/restoreUnknownType.test.ts`). One upstream test asserted the old behaviour; it was **inverted rather than deleted**, so the new contract is pinned exactly where the old one was.

This work is upstream-general — it makes any Excalidraw fork's custom types survive a round-trip — and would be the right change even if Lawha added no types at all.

**The residual risk, stated plainly.** This protects clients running this commit forward. An **older deployed bundle** still deletes these elements and persists the deletion, and so does upstream Excalidraw opening an exported `.excalidraw`. That is a distribution problem, not a code problem: anyone on a stale bundle should reload before opening a board that contains one. There is no version of this feature without that caveat, and 0023's alternative — `customData` on ordinary types — merely moved the failure from "the table disappears" to "the table is a pile of rectangles".

## Column widths are fractions, and that is the whole fix

`colWidths: number[]` and `rowHeights: number[]`, each summing to 1, multiplied by `width`/`height` at draw time.

This is the highest-leverage decision here and the one that actually retires the reported defect. Not because it _prevents_ overlap — because it makes overlap **unrepresentable**. A divider drag moves weight between exactly two neighbours and floors both at `minFraction = 0.02`; the total is always 1, so there is no arrangement of a valid `colWidths` that overlaps two cells. A test drags the sequence `[0.4, 0.4, 0.4, -0.9, 0.9, -0.4]` through it and asserts the invariant survives; the browser probe drags a divider 627px past its neighbour and lands on `[0.6467, 0.02, 0.3333]`, sum exactly 1.

It also means `resizeSingleElement` needs **no table branch at all** — a table scales correctly on an ordinary bounding-box resize for free, where a pixel-width model would have needed a case in `resizeElements.ts` beside the image `scale` one.

## Interior handles are a parallel system, on purpose

`TransformHandles` is a closed type — `Partial<Record<"n"|"s"|"w"|"e"|"nw"|"ne"|"sw"|"se"|"rotation", Bounds>>` — with `omitSides` as its only extension point, and `omitSides` can only _subtract_. A table's dividers and anchors therefore cannot be transform handles, and pretending otherwise would mean editing the shared type.

`TableElementEditor` copies `LinearElementEditor` field-for-field instead: an id-only state bag in appState, statics taking `(element, elementsMap, pointer, zoom)`, and a **zoom-independent hit radius** (`DIVIDER_HIT_PX / zoom`) so the grab zone is a constant number of screen pixels at any zoom.

Two arbitration rules, and they point in opposite directions on purpose:

- **Dividers win over the bounding box.** They are strictly interior and collide with nothing.
- **The bounding box wins over anchors.** Anchors sit just _outside_ the table, where the `n`, `w` and corner handles already live. Claiming those pixels would trade a resize gesture for a select gesture that the rest of the anchor strip already offers.

The drag is self-contained — its own `window` listeners and one early return, following `handleDraggingScrollBar` — rather than four branches threaded through the shared pointer handlers. That is where a subtle ordering bug would otherwise live.

## Cell text is a string on the element, not a bound text element

`getBoundTextElementId` uses `.find()`, so a container holds exactly one label; a nine-cell table would need nine containers. `textWysiwyg` also strips _every_ text binding when a label is emptied, and `restore.ts` re-dedupes on load.

So cells carry plain strings, and the editor is a DOM `<textarea>` positioned over the cell — the **frame-name** pattern (`App.tsx:2144`), not the `textWysiwyg` one. It survives collab and export for free, because there is nothing to survive: the text is already element state.

The same pattern gives the code block its source editor and the tensor its shape editor. Double-clicking the thing you want to change is the gesture everyone tries first, and on a tensor the numbers _are_ the content.

## What changed in `mutateElement`, and why it had to

`mutateElement` dropped the shape cache only for `width`, `height`, `fileId` and `points`. These three types paint straight onto their element canvas rather than through roughjs, so their **content is their shape** — and `ShapeCache.delete`, which also drops the cached canvas, is the only thing that makes an edited cell or a dragged divider repaint. The keys that carry the drawing are listed explicitly rather than invalidating on every mutation, so an ordinary drag does not regenerate a syntax-highlighted canvas on every frame.

`shouldTestInside` gained the same three types beside `isImageElement`. Clicking the middle of a table selected nothing, because the rule is "grabbable from inside only if the background is not transparent" — right for a hollow rectangle, wrong for a thing that draws its own grid, its own dark card, its own shaded box. **What you see filled is what you expect to be able to grab.**

## What is kept from 0025

`codeHighlight.ts` moves into `packages/element/` **unchanged**, and with it the whole of 0025's reasoning about highlight.js: `highlightAuto` is the only mainstream language _detector_, and naming the language is exactly what somebody pasting a snippet onto a whiteboard does not want to do. Only the core and twenty grammars are registered — a bundle decision and an accuracy one, since auto-detection scores every registered candidate. The highlighted HTML is still parsed with `DOMParser` rather than a regular expression, because a regex over somebody's string literal is how a highlighter starts corrupting the code it is meant to be colouring.

What is dropped is the SVG round-trip. 0025 chose "render to SVG, place as an image" to keep the element count at one without touching `packages/`. With a real element type the renderer holds a raw 2D context and sets `fillStyle` per token directly, so the intermediate picture buys nothing — and its cost was the double-click collision with image cropping.

## Consequences

- **The fork is materially harder to merge.** 41 edited upstream files including `App.tsx`, which invariant 10 names as the most merge-hostile file in the tree. The mitigation is structural, not magic: logic lives in the 19 new files, and the edits to shared files are `case` labels, one-line list entries and single branches. It is a mitigation, not a cure.
- **Existing boards are not migrated.** A table or code block already drawn under 0023/0025 stays as loose rectangles and an image. The `customData.lawha` tags carry enough to rebuild them and a converter is possible later; this is said out loud here rather than discovered.
- **`packages/element` now depends on `highlight.js`.** It moved with the file it belongs to.
- **Undo is one step per gesture**, captured after the last mutation rather than before the first — scheduling it up front would record the state the drag started from and give back a half-finished table.

---

## Amendment — the rendering split, corrected

The first implementation of this ADR put `table`, `tensor` and `code` in `_generateElementShape`'s `frame | magicframe | text | image` group, which returns `null`, with a comment saying they draw themselves so there is no roughjs shape to generate.

**That was the wrong analogy, and it is worth recording why**, because it is the kind of mistake that looks correct in a diff. Text and image belong in that group because neither has a stroke to roughen — one is glyphs, the other pixels. A table is ruled lines and a border, which is exactly what roughjs exists to draw. The right analogy was never `text`; it was `rectangle`.

Returning `null` skipped `generateRoughOptions`, and with it six things at once:

| Lost | Symptom |
| --- | --- |
| roughjs stroke | machine-straight lines on a hand-drawn canvas |
| `applyDarkModeFilter` | `#1e1e1e` on a `#121212` canvas — invisible in dark mode |
| `roughness` | the panel's **Sloppiness** control did nothing |
| `strokeStyle` | the panel's **Stroke style** did nothing |
| `fillStyle` | hachure and cross-hatch cell fills impossible |
| `seed` | no per-element stroke variation |

The elements carried all four properties; the renderer ignored every one.

### The chosen split

**Roughjs draws the container and the rules. The raw context draws the content.** `freedraw` already mixes the two inside one `case` (`renderElement.ts:350-370`), and `line`/`arrow` already return `Drawable[]`, so neither the shape type nor the renderer needed inventing.

Content stays precise on purpose: a matrix is read for its numbers and a code block for its tokens, and roughening either trades legibility for texture in the one place legibility is the whole point.

### What else the review found, and fixed

- **SVG export emitted a dashed grey placeholder** for all three types — the unknown-type branch this ADR itself added, for types a build cannot draw, which this build plainly can. Invisible on canvas and in PNG, because only SVG takes that path.
- **`fontSize` was a module constant**, so `resizeSingleElement` could not reach it and a table dragged to 2× kept 16px text while its cells doubled.
- **The anchor strip started at `DEFAULT_TRANSFORM_HANDLE_SPACING`** — the exact offset the transform handles are placed at — so corner handles were drawn on top of it, and a fixed 12px target sat beside a 28px one on touch.
- **The properties panel hand-rolled every control**, including a 44px blue `CheckboxItem` built for export dialogs and a row of text buttons whose CSS was entirely dead against `.excalidraw .buttonList button`. It also never mounted in `CompactShapeActions`, so a table was unconfigurable on a tablet.
- **`highlight()` ran unmemoised on every repaint** — `highlightAuto` over nineteen grammars plus a `DOMParser` parse, per frame of a drag.

### Two things the review got wrong, recorded so they are not re-fixed

- The cell editor was reported as using the wrong font. It does not: `getComputedStyle` returns `Excalifont` and `document.fonts.check` passes.
- `document.fonts.check('16px Cascadia')` returning false looked like the matrix and code editors falling back to a generic monospace. It cannot happen: the element renders before its editor can open, and that render registers the face. Measured true with a code block present.

### Notion, adopted deliberately

Three behaviours, each for a stated reason rather than because Notion has them:

- **anchors and buttons are revealed by hover**, so a table at rest carries exactly the chrome a rectangle carries;
- **a `+` at the trailing edge of each axis** adds a row or column where you are already looking, instead of sending you to a side panel;
- **the column anchor is the selection control** — click selects, drag reorders.

### Still not done

- CSV/TSV paste, LaTeX in cells and per-column types are not implemented. Each is its own feature.
- No migration for boards drawn under 0023/0025.
- RTL locales (`ar-SA`, `he-IL`, `fa-IR`) do not carry the new keys and fall back to English.
