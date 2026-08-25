# 0027 — Cell text properties are per cell, and alignment has a vertical axis

**Status:** accepted. **Amends [0026](0026-native-grid-elements.md).**

**Affects:** `packages/element/src/{types,tableElement,newElement}.ts`; `packages/excalidraw/data/restore.ts`; `packages/excalidraw/renderer/lawhaSvg.ts`; `packages/excalidraw/components/LawhaElementActions.tsx`.

## Context

0026 shipped `textAlign` on the **element**, and said why, in the type itself (`types.ts:213-219`):

> Element-level rather than per cell: a column of numbers aligned three different ways is a mistake, not a feature, and per-cell alignment is the kind of state that only ever gets set by accident.

That argument is still right about the failure mode it names. It is wrong about the table it was imagining. The reasoning assumed a grid that is uniform in kind — a matrix, where every cell is a number and any variation between them is noise. **A results table is not that.** It is a label column and then numbers:

| Model     |    Params |     Acc. |
| --------- | --------: | -------: |
| ResNet-50 |     25.6M |     76.1 |
| **Ours**  | **21.3M** | **78.4** |

Left-aligning that first column and right-aligning the rest is not an accident anybody had; it is the convention every venue prints. Under 0026 the table is forced to choose one, and both choices are wrong somewhere. The same table also wants **the best row in bold**, which 0026 has no representation for at all outside the automatic header.

There is no vertical alignment in the fork whatsoever. `drawTableOnCanvas` sets `context.textBaseline = "top"` unconditionally and derives `y` from the row's top edge plus a constant (`tableElement.ts:631,702`). A one-line cell in a tall row therefore floats at the top of it, which is visible the moment one cell in a row wraps to three lines and its neighbours do not.

## Decision

**Cell text properties resolve per cell, falling back to the element.**

```ts
// TableCell
align?: "left" | "center" | "right" | null;
verticalAlign?: "top" | "middle" | "bottom" | null;
bold?: boolean | null;
italic?: boolean | null;
```

Both optional **and** nullable, and the distinction carries meaning:

- **absent** — written by a build older than this one. Inherit.
- **`null`** — this cell was explicitly set back to inheriting. Inherit.
- a value — use it.

The element keeps `textAlign` and gains `verticalAlign`, both acting as the default every cell falls back to. `verticalAlign` defaults to `"top"`, which is what every existing board already draws, so **no board changes appearance on load.** That is the whole backward-compatibility story and it is worth stating that it required no migration: a cell with none of the four keys renders byte-identically to how it rendered before.

0026's concern is answered by where the controls write, not by removing the capability. The panel already has the right idea: the fill and text-colour pickers write **to the bulk selection when there is one, and to the whole grid when there is not** (`LawhaElementActions.tsx`). Alignment now does the same. Setting one cell's alignment therefore takes selecting that cell first — a deliberate act — while the gesture that is easy, "click the table and press centre", still does the thing 0026 wanted and aligns everything. The accident it feared needs a bulk selection to happen.

### `restore.ts` is load-bearing here, and would have silently eaten this

`restoreElement`'s `table` case does not spread the cell. It rebuilds it, field by field (`restore.ts:740-747`):

```ts
cells: cells.map((row) => Array.from({ length: cols }, (_, col) => ({
  text: ..., fill: ..., color: ...,
})))
```

Any key not named there is **dropped**. Not on export, not on some edge case — on every ingest path `restoreElements` runs on, which per 0026 includes remote elements during collaboration. The failure would have been: alignment works, survives a reload of your own tab, and disappears the moment a second person's client round-trips the scene. The four new keys are named in that mapping, and the normalisation is the same defensive shape the rest of the case already uses.

This is the same class of defect 0026 opened with — `restore.ts` filtering unknown types — arriving by a different door. **The lesson generalises past this ADR: adding a field to one of these elements is not done until `restore.ts` knows about it.**

### One resolver, two renderers

Alignment maths existed twice: once in `drawTableOnCanvas` and once in `renderTableTextToSvg` (`lawhaSvg.ts`). Two axes and four properties would have made that two copies of something worth getting wrong. A single `resolveCellText()` in `tableElement.ts` now returns the resolved font and the placed lines, and **both** renderers consume it; neither computes a position itself.

0026 already paid for this lesson once — SVG export emitted a dashed placeholder for all three types because the canvas path was the only one anybody looked at. _A type is not finished until it exports_, and neither is a property.

## What is deliberately not in this

- **Per-cell borders.** A table's rules are **one** roughjs path for the whole grid (`generateTableShapes`, `tableElement.ts:559-584`). Per-cell borders mean per-edge generation, and the shape cache is regenerated on content change, so it is a real cost on every keystroke in a cell. Worth doing deliberately, not as a rider on this.
- **Per-cell padding.** `CELL_PADDING` is a constant (`tableElement.ts:35`) and text is clipped to the cell rect. Making it a field means it participates in wrapping, which is where the cost is.
- **Merged cells (`colspan`/`rowspan`).** `cells` is a strict dense row-major array and every consumer assumes it — `getCellAt`, `getCellRect`, divider hit-testing, anchor reordering, bulk selection. Merging is not a cell property; it is a different grid model, and it should get its own ADR rather than be smuggled in beside an alignment change.
- **Per-cell font family and size.** `fontSize` is on the element and is scaled by a bounding-box resize; a per-cell size would have to decide what a resize does to it. No use case has asked yet.

## Consequences

- **The panel's alignment control changes meaning when a selection exists.** It reads identically to the fill and colour pickers beside it, which is the argument for it, but it is a change in behaviour for anyone who had learned the old one.
- **Divergence grows by no new files** — four fields, one resolver, one restore mapping and one panel group, all in files 0026 already diverged. No new `App.tsx` hook points.
- **A cell can now be made illegible on purpose** (white on white), the same way `strokeColor` already allows. `inkOn`'s automatic contrast remains the behaviour when `color` is unset; an explicit value still wins, unchanged from `b3f0913d`.
- **The heatmap's value range excluded nothing before and now excludes the header row.** Strictly a bug fix rather than part of this decision, but it lands here: `numericCells` flattened every cell, so a column headed `2020` was both heat-coloured and counted in the min/max that scales every other cell.
