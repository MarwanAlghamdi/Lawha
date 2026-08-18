# 0023 — Tables and tensors are composed, not a new element type

**Status:** accepted. **Adds nothing to `packages/`. The divergence stays at 14 files, and that is the point of this ADR rather than a footnote to it.**

**Affects:** `excalidraw-app/lawha/table/*` (new), `excalidraw-app/lawha/dataviz/*` (new), one mount point in `excalidraw-app/App.tsx`, one button in `LawhaTopBar`. No file under `packages/` is touched.

## Context

Lawha needs tables — fill cells, colour them, select a column from a handle above it, the way Notion does — and a small family of data-science objects: numeric matrices, and blocks annotated with their dimensions including isometric 3-D tensors for drawing model architectures.

The obvious implementation is a new `table` element type in the discriminated union at `packages/element/src/types.ts:206`, with its own renderer, tool and resize behaviour. That is how `frame` and `image` work, and it is what "add a table object" sounds like it means.

It would have destroyed user data.

## `restore.ts` does not ignore an unknown type. It deletes it.

`packages/excalidraw/data/restore.ts:507-709` is a `switch (element.type)` with **no `default` case**. An element whose type matches nothing falls out of the switch and hits `return null` at `:708`; `restoreElements` then filters the nulls at `:818`. The comment at `:704-706` says this is deliberate.

`restoreElements` is not an edge path. It runs on initial data, on every scene load from lawha-server, on file open, on clipboard paste, and on library insert — and in `excalidraw-app/data/storage/lawha.ts` it runs on **remote** elements before `reconcileElements` (`:316`, `:375`). So the sequence for anyone on a client that does not know the type is: load the board, silently drop every table, and then save the scene back with the tables gone. The deletion propagates to the server on the next write.

That "anyone" is not hypothetical. It is any browser with a cached older bundle, anyone opening an exported `.excalidraw` file in upstream Excalidraw, and every Lawha instance that has not deployed the same version. Two further passes make it worse: `repairContainerElement` and `repairFrameMembership` (`:757`, `:797`) then strip the dangling references, so cell text is orphaned and mutated rather than merely detached.

`packages/element/src/renderElement.ts:984` also ends its switch with `default: throw new Error("Unimplemented type")`, so an unknown type that somehow survived restore crashes the frame instead.

There is no unknown-type escape hatch, and adding one is a change to the most-merged file in the tree.

## So a cell is a rectangle, and a table is a set of them

A cell is an ordinary **rectangle container with a bound-text label**. Each carries its position in the grid on `customData`:

```ts
customData.lawha = { kind: "table-cell", tableId, row, col, header };
```

`customData?: Record<string, any>` is declared on the element base at `packages/element/src/types.ts:81` and preserved verbatim by `restore.ts:472-475`. It is the only per-element extension point that survives a client which knows nothing about it — which is the whole requirement.

Construction goes through `convertToExcalidrawElements`, already exported at `packages/excalidraw/index.tsx:485`; its `ValidContainer` skeleton (`packages/element/src/transform.ts:165-176`) takes a `label`, which is how each cell gets its text. No new tool, no new renderer.

## Amended: the cells are not grouped

**The first version grouped them, and that was wrong.** A `groupIds` entry does make the editor treat the table as one object — but it also puts an "enter the group" step in front of every cell. Measured on a real board: a double-click selected the cell, and only a **second** double-click began typing in it. Four clicks to fill one cell, in a thing whose entire purpose is being filled in. It was reported within minutes of first use.

So cohesion moved out of the editor and into the overlay:

- **`tableSnap.ts` keeps the grid rectangular.** Every cell implies where the table's origin must be — subtract its column times the cell width from its x. Cells that have not moved all imply the _same_ origin; a dragged one implies a different origin and is outvoted, then returned to its place when the pointer comes up. A per-column median was tried first and is wrong for the common case: with two cells in a column the median _is_ the mean, so one dragged cell pulls the expected position halfway out to meet it.
- **The overlay draws a move bar** along the table's top edge. Dragging it translates every cell and label together — this is where "the table is one thing" now actually lives.
- **A tensor block stays grouped.** Nothing is typed into it; it is one shape made of three faces, so grouping costs nothing and keeps it moving as a unit.

The trade is explicit: an ungrouped cell _can_ be dragged out of the grid, and the snap is what makes that recoverable rather than destructive. `e2e/gridObjects.spec.ts` pins both halves — one double-click starts typing, and a cell dragged 350px away comes back.

The failure mode inverts. An old client now sees a grid of labelled rectangles — which is precisely what a table is — and saves it back unharmed.

## What this costs, stated plainly

**A composed table is not a first-class object.** Dragging a corner resizes cells individually rather than the table, so resize, insert-row and delete-column are ours to implement in the overlay. That is real work the native type would have given us free.

**Cells reconcile independently.** `packages/excalidraw/data/reconcile.ts` is type-agnostic and resolves last-writer-wins _per element_. Two people editing one table concurrently can land a mix of both edits, and there is no transaction that would have made it atomic. The alternative — the whole grid inside one element's props, like `points[]` on a linear element — is atomic, and is exactly the native type this ADR refuses. So this is the cost of that refusal, and it is the one to weigh if we ever reopen the decision.

In practice it degrades the way a multi-element selection already degrades in Excalidraw, and `readTable` is written to tolerate a missing cell rather than throw. A grid with a hole in it is recoverable. A grid that was deleted on load is not.

**The overlay is UI, not enforcement.** It must be gated on `boardAccess.canEdit` like every other write surface (invariant 24 — guard the funnel), and it must render into the editor container rather than as Radix popover content (invariant 11).

**Every action is one undo step.** `updateScene` defaults to `CaptureUpdateAction.EVENTUALLY`, which folds a change into some later increment — so inserting a table and pressing Ctrl+Z undid whatever came next and left the table behind. Also reported on first use. Every write here passes `CaptureUpdateAction.IMMEDIATELY`, except the frames mid-drag, which are captured once when the pointer comes up.

## What would make us reopen this

If per-cell reconciliation proves genuinely unusable in practice — not theoretically lossy, but observed to lose work — the escape hatch is a native element type plus a permissive `default` case in `restore.ts` that preserves unknown types instead of dropping them. That second half is the expensive part and the part upstream would have to accept, so it is a conversation to have with upstream rather than a patch to carry.

Until then: nothing on this canvas needs a type the rest of the world cannot read.
