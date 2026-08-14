# ADR 0001 — Collaborator colours come from a fixed palette

**Status:** accepted **Affects:** `packages/excalidraw/clients.ts`, `packages/common/src/colors.ts`, `packages/excalidraw/renderer/interactiveScene.ts`

## Context

Upstream Excalidraw derives a collaborator's colour by hashing their id into a hue: `hsl((hash % 37) * 10, 100%, 83%)`. That is a good fit for a product where cursors are the only place a collaborator is represented.

Lawha shows the same person in two places at once — the cursor drawn on the canvas, and the avatar stack in the top bar. Those are rendered by entirely separate code paths: the cursor by `renderRemoteCursors` writing to a `CanvasRenderingContext2D`, the avatar by React writing DOM. A user appearing as two different colours in the same session reads as a bug, and there is no render prop, tunnel, or `renderConfig` hook that would let host code supply the cursor colour from outside the package.

The mockups also specify a closed five-value palette rather than a continuous hue wheel, and pastel `83%` lightness cannot carry white label text.

## Decision

`COLLABORATOR_PALETTE` in `packages/common/src/colors.ts` is the single source of truth: five OKLCH colours, each shipped in three forms.

- `oklch` — for CSS, used by the Lawha token layer.
- `hex` — for canvas `fillStyle`. Canvas cannot be relied on to parse `oklch()` in older Safari and embedded WebViews, so the conversion is done ahead of time.
- `hexDark` — the pre-image of `hex` under the interactive canvas's dark-mode filter.

Both sides index the palette with `getCollaboratorPaletteIndex(id)`, so they cannot disagree.

### The dark-mode pre-image

`packages/excalidraw/css/styles.scss` applies `filter: invert(93%) hue-rotate(180deg)` to `.excalidraw__canvas.interactive` in dark mode. Anything drawn there is therefore transformed before the user sees it. Drawing `hex` in dark mode would render as its inverse and no longer match the avatar — which lives in the DOM and is **not** filtered.

`hexDark` is computed by inverting that transform, so drawing it lands on `hex` on screen. Only callers that draw onto the interactive canvas pass a theme; the DOM avatar list (`actions/actionNavigate.tsx`) and the SVG laser layer (`laserTrails.ts`) deliberately omit it and get the unfiltered value.

## Alternatives rejected

**Leave `getClientColor` alone and match the avatar to it.** Would reproduce the hue hash in CSS and re-introduce the same drift risk on any upstream change, while still leaving the pastel/white-text contrast problem unsolved.

**Re-implement cursors as DOM overlays.** Would duplicate pointer interpolation, idle-state alpha, out-of-bounds clamping, the click ripple, and follow mode — far more divergence than the ~20 lines changed here.

## Consequences

- `getClientColor` gains an optional third `theme` parameter. The signature is backwards compatible; existing callers keep the unfiltered colour.
- The cursor name chip is now filled with the user's colour and labelled in white at radius 4 (was: white fill, charcoal label, radius 8). The palette sits at OKLCH lightness 0.55–0.6, where charcoal would fail contrast.
- **This file will conflict when merging upstream.** Keep the palette lookup and re-apply it over whatever upstream does to the surrounding rendering code.
- `packages/excalidraw/tests/clients.test.ts` pins the contract: palette membership, stability per id, collaborator-id precedence over socket id (so colour survives reconnects), distribution across all five entries, and the light/dark pairing.
