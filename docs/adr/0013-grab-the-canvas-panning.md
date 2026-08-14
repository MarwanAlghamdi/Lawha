# 0013 — Panning feels like holding the canvas: momentum, and a right-button drag

**Status:** accepted. **Adds four paths to `packages/`, taking the divergence from nine to thirteen — see invariant 10 and the accounting below.**

**Affects:** `packages/excalidraw/components/App.pan.ts` (new), `packages/excalidraw/components/App.tsx` (hooks only), `packages/excalidraw/tests/appPan.test.ts` (new), `packages/excalidraw/tests/rightDragPan.test.tsx` (new).

## Context

Moving around a Lawha board meant one of three things: hold space and drag, pick the hand tool, or scroll. A plain drag on empty canvas draws a rubber-band selection, which is right for an editor and wrong for the thing people actually do most on a shared board — look around it.

The request was literal: _"allow drag and drop like I'm holding the canvas in a way so it is much better."_ Holding a thing means it has weight. A pan that stops dead the instant you let go does not feel held; it feels like a scrollbar.

Three behaviours were chosen over the alternatives:

1. **Momentum** — the viewport keeps travelling after release and decays, so a flick covers distance and a slow drag places precisely.
2. **A right-button drag pans**, so the gesture is available without a modifier key or a tool change.
3. **The grabbing cursor**, which the existing pan already sets, is kept and extended to the new entry point.

## Why this needs an ADR at all

**Invariant 10 caps `packages/` divergence**, and the roadmap's known issue 20 already records the count running over its stated figure — nine paths, measured, against an invariant that says four. The invariant's purpose is that an upstream merge stays tractable. Adding to that number is exactly the decision it exists to slow down, so this records what was added and why it is the cheap shape rather than the expensive one.

**What was rejected:**

- **Putting the momentum in `excalidraw-app/`.** There is no seam. Velocity has to be sampled from the same pointer stream the pan already consumes, and the glide has to write through `viewport.translate` so scroll constraints, overscroll and the follow-mode cancel all still apply. Driving it from outside would mean a second set of pointer listeners racing App's own.
- **Editing `App.cursor.ts`.** Not needed, and this is worth stating because the plan assumed it would be. `handleCanvasPanUsingWheelOrSpaceDrag` already sets `CURSOR_TYPE.GRABBING` for the whole pan session, and `AppCursor.applyForTool` already sets `GRAB` for the hand tool and in view mode. The right-button drag enters through the same function, so it inherits both. **One fewer diverged file than planned.**
- **A Hand button in `LawhaTopBar`.** Also planned, also dropped: `HandToolButton` is already rendered by both `Toolbar.tsx` and `MobileToolbar.tsx`. A second control for the same tool is clutter, not discoverability.

## Decision

**The momentum lives in a new Lawha-owned file; `App.tsx` gets hooks and nothing else.**

`packages/excalidraw/components/App.pan.ts` holds all of it — sampling, the launch-velocity calculation, the decay loop — as an `AppPan` class following the `AppCursor` / `AppViewport` shape already established in that directory.

**A new file is the cheapest kind of divergence, because it cannot conflict.** Upstream will never touch a path it does not have. What costs is the edit to `App.tsx`, which is upstream's hottest file, so the hooks are kept to single lines at five points and each is listed here so a future merge conflict can be resolved without rediscovering the design:

| Hook | Where | What |
| --- | --- | --- |
| `public pan = new AppPan(this)` | field, beside `cursor` and `viewport` | construction |
| `this.pan.begin()` | `handleCanvasPanUsingWheelOrSpaceDrag`, after `isPanning = true` | cancels any glide still running, starts a fresh sample buffer |
| `this.pan.sample(...)` | that function's `onPointerMove` | one position per frame |
| `this.pan.release()` | that function's `teardown` | launches the glide, and **owns the overscroll snap-back when it does** |
| `this.pan.destroy()` | `componentWillUnmount` | cancels a glide that outlived the editor |

Plus the right-button arm: `POINTER_BUTTON.SECONDARY` in the pan gate, and the context-menu handling below.

**The glide writes through `viewport.translate`, never `setState` directly.** That is what keeps scroll constraints, the `userToFollow` cancel and the zoom cache honest during a glide, and it is why `translate` returning `false` stops the glide rather than being ignored — a locked transition means something else owns the viewport.

**The snap-back moves with the glide.** `teardown` used to call `viewport.releaseOverscroll` as its `setState` callback, with a comment explaining it must run after the trailing throttled pointer move so the rubber-band starts from the pan's real final viewport. A glide invalidates that: the viewport is still travelling. So `release()` returns whether it launched, `teardown` calls `releaseOverscroll` only when it did not, and the glide calls it when it stops. The original comment's reasoning is preserved, not discarded — the final viewport is simply later than it used to be.

### The right-button drag, and what it does to the context menu

**A right-drag cannot be decided at pointer-down, and the browser decides the context menu there.** On Chrome under Linux, `contextmenu` fires immediately after `pointerdown` — before any movement exists to distinguish a click from a drag. Under Windows, and in Firefox, it fires at pointer-up. There is no single moment that works for both.

So: **while a right-button pan session is open the native context menu is suppressed, and a session that ended without crossing the movement threshold opens the menu itself at pointer-up.**

This is not a new mechanism. `maybeOpenContextMenuAfterPointerDownOnTouchDevices` already calls `handleCanvasContextMenu` by hand for touch, for the same reason — the platform's moment is the wrong one.

Consequences of that, stated plainly:

- **A right-click's menu now appears on release rather than on press** on platforms that fired it on press. The delay is the duration of the click.
- **The grabbing cursor is deferred for the secondary button** until movement crosses the threshold, so a plain right-click does not flicker into a grab.
- **The re-open is guarded on the event being a React synthetic one.** `handleCanvasPanUsingWheelOrSpaceDrag` also accepts a raw `MouseEvent` — `textWysiwyg` passes one — and `handleCanvasContextMenu` reads `event.nativeEvent`, which a raw `MouseEvent` does not have. Calling it with one would throw on `"pointerType" in undefined`.

**No existing test changes behaviour under this.** Measured, not assumed: every context-menu test in `packages/excalidraw/tests/` reaches the menu through `fireEvent.contextMenu` or `mouse.rightClickAt`, and neither fires a right-button `pointerdown`. The suppression is gated on a right-button pan session existing, so a bare `contextmenu` event is untouched. That is a fact about today's suite rather than a guarantee, which is why the new tests pin both halves — suppressed after a drag, opened after a click.

## Consequences

**Invariant 10's count goes from nine to thirteen, and this is the second time the roadmap's own list has had to be corrected rather than the invariant's number.** Known issue 20 catalogues the first. The number in the invariant text is still wrong in a different direction; fix it there when someone opens it for a real reason, and do not let this ADR become the precedent that the count is soft.

The four are `App.pan.ts`, `App.tsx`, and the two test files — and **three of the four are new files, which cannot conflict on a merge because upstream has no such path.** The one that can is `App.tsx`, and its five hooks are enumerated above precisely so that conflict is resolvable without rediscovering the design. The tests live beside their subject rather than in `excalidraw-app/`, on the same reasoning that already puts `tests/clients.test.ts` there: a test that has to reach across the package boundary to find what it covers gets deleted by the next person who tidies up.

**A glide is cancelled by the next interaction, not by a timer.** `begin()` cancels, so any pan start kills the previous glide; `destroy()` covers unmount. A glide surviving into a drawing gesture would move the canvas under the stroke, which is the failure this guards.

**Frame deltas are clamped.** A backgrounded tab resumes with a multi-second `requestAnimationFrame` delta, and an unclamped one would teleport the viewport across the scene on return.

**The launch velocity is measured over a short trailing window, not the whole gesture.** A long slow drag that ends in a flick should fling; the same drag ending in a pause should stop. Averaging the gesture would get both wrong.

**What this does not change:** a primary-button drag on empty canvas still rubber-band selects. Panning gained an entry point; it did not take one away. Space-drag, the hand tool, the wheel button and view-mode drag all behave exactly as before, because they all still enter through the same function.

---

## Amendment, 2026-08-06 — momentum is off

**The glide is disabled on this deployment.** `MOMENTUM_ENABLED` in `App.pan.ts` is `false`; `AppPan.release()` returns `false` immediately, which is the same "nothing is still moving the viewport" contract a too-slow release already had.

The original premise above — "holding a thing means it has weight… a pan that stops dead does not feel held" — turned out to cut both ways in use. The viewport carries on after the hand has stopped, and on a canvas where the next action is usually placing something at a particular spot, that reads as drift rather than as weight: you aim, release, and the target has moved.

**Everything else in this ADR stands.** The right-button drag-to-pan, the intent threshold, the context-menu rule, the frame clamp and the trailing velocity window are all unchanged and still enforced by `rightDragPan.test.tsx`. `computeLaunchVelocity` stays live — the overscroll rubber-band reads the same samples — and `appPan.test.ts` still pins its arithmetic.

Switched rather than deleted. Deleting `App.pan.ts` would take the right-button drag and the velocity sampling with it and make this decision unrecoverable; flipping the constant to `true` restores the glide exactly. `appPan.test.ts` pins that it is off, and that test fails if the constant is flipped — verified, rather than assumed.

**The divergence count is unchanged**: this touches only paths this ADR already added.
