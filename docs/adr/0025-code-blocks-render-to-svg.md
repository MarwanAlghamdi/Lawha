# 0025 — A code block is a picture, and the source is what we keep

**Status:** superseded by [0026](0026-native-grid-elements.md). The highlight.js reasoning below survives verbatim — `codeHighlight.ts` moved into `packages/element/` unchanged. What was dropped is the SVG round-trip, whose cost was a double-click that entered image cropping.

<sub>Original status: **Status:** accepted. **Adds nothing to `packages/`; divergence stays at 14 files.** Adds one dependency, `highlight.js`.</sub>

**Affects:** `excalidraw-app/lawha/code/*` (new), one tool in `lawha/table/gridTools.ts`, one mount in `excalidraw-app/App.tsx`.

## Context

A code block wants syntax colours, and an Excalidraw text element carries exactly one `strokeColor`. Colour is per element, so a coloured token is an element — and a twenty-line snippet is a hundred of them, each reconciling independently and each rebuilt from scratch on every keystroke. Tables already pay a version of that cost with twelve cells; a hundred is a different thing.

## So it renders to SVG, and is placed as an image

`image/svg+xml` is already an accepted image type (`packages/common/src/constants.ts:238`), and an image element is one element. Vector rather than raster because a code block is read at every zoom level and a bitmap turns to mush at 200%.

What that buys, beyond the element count: complete control of the design. The card has a header bar, three dots, the language name, a line-number gutter and a real monospace face, because none of that has to be assembled from canvas primitives — it is just SVG we emit.

**The picture is derived. The source is not.** Both the snippet and the language choice live on `customData`, which `restore.ts` preserves verbatim (`:472-475`). Losing the SVG costs a re-render; losing the source would lose the user's work, so the source is what the scene actually stores.

## highlight.js, for one reason

The editor already bundles CodeMirror and `@lezer/highlight` for the mermaid dialog, and neither can do the thing that matters here: **detect the language**. A lezer grammar parses a language you have already named, and naming it is exactly what somebody pasting a snippet onto a whiteboard does not want to do. `highlightAuto` is the only mainstream implementation of that.

Only the core and twenty grammars are registered, not all ~190. That is a bundle decision and also an accuracy one — auto-detection scores every registered candidate, so a smaller, likelier set detects _better_, not just faster.

The highlighted HTML is parsed with `DOMParser` rather than a regular expression. The payload contains escaped source text, and a regular expression over somebody's string literal is how a highlighter starts corrupting the code it is meant to be colouring.

## One dark palette, whatever the board theme is

Code reads as code. Contrast is predictable, there is one palette to keep accessible rather than two, and a block exported from a dark board looks identical to one exported from a light board — which matters, because the export usually outlives the session.

## What this costs

**The text is not selectable on the canvas.** It is a picture. Editing goes through a panel, and copying code out of a board is not yet possible — a "copy" action on the block's bar is the obvious answer and is not built.

**Each distinct snippet becomes a file on the server.** The file id is a content hash, so re-saving identical source reuses the existing file rather than uploading another, and an edit that is later undone costs nothing new. But a block edited into twenty different states leaves twenty small SVGs behind. They are a few kilobytes each and nothing collects them.

**Fonts are named generically.** An SVG inside an `img` cannot fetch a web font, so the card asks for the platform monospace. Glyph shapes therefore vary slightly between machines — but not the layout: every run is drawn with an explicit `textLength` and `lengthAdjust="spacingAndGlyphs"`, so runs cannot drift apart or overlap however the viewer resolves the family.

## What would make us reopen this

Selectable text on the canvas. If people want to copy code out of a block often enough, the answer is not a hundred text elements — it is the native element type that ADR 0023 keeps as its escape hatch, with a renderer that draws coloured runs directly. That is a `packages/` change and a large one, and it should be driven by somebody actually asking for it rather than by symmetry with the tables.
