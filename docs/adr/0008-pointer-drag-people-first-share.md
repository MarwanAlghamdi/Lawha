# ADR 0008 — Pointer drag, a people-first Share panel, and four silent sync defects

**Status:** accepted **Affects:** `excalidraw-app/lawha/home/useBoardDrag.ts`, `excalidraw-app/lawha/home/HomeRoute.tsx`, `excalidraw-app/lawha/home/LawhaFolderSidebar.tsx`, `excalidraw-app/lawha/home/boardFilters.ts`, `excalidraw-app/lawha/share/**`, `excalidraw-app/collab/Portal.tsx`, `excalidraw-app/collab/Collab.tsx`, `packages/excalidraw/laserTrails.ts`, `excalidraw-app/components/AppMainMenu.tsx`, `setupTests.ts` **Amends:** ADR 0002 §3 (the laser's theme resolution); ADR 0007 (the "Unfiled" pile and the breadcrumb strip it added)

## Context

Seven complaints from using the product. Three were cosmetic removals. The other four were defects, and every one of them failed **silently** — a failure mode where subsystems with no way to report failures present their failures as absence, and absence gets reported as a different bug entirely.

## Decision

### 1. Drag and drop is built on pointer events, not HTML5 drag

ADR 0007 chose the native API because "a board-onto-folder drop needs about forty lines of it". That was true and still cost too much:

- **`dragstart` does not fire from a touch.** Not "fires oddly" — does not exist. The feature was simply absent on a tablet, with nothing on screen admitting it.
- **The browser will not scroll during a native drag,** so a folder below the fold was unreachable: you could pick a board up and have nowhere to put it.
- The drag image was the browser's — a cropped, half-transparent snapshot of a 220px card, which is not a useful thing to be holding when the question is "which folder am I over".
- A drag beginning inside a `<button>`, which the card's whole preview is, is honoured by some browsers and swallowed by others.

Pointer events answer all four. They also delete the jsdom scar tissue: the old version wrapped every `dataTransfer` write in try/catch because `effectAllowed` is a read-only accessor there and assigning to it threw, aborting the drag.

A 5px threshold separates a drag from a click, so the card still opens; a touch starts on a 400ms hold, so a flick still scrolls the page.

**Boards and folders share one implementation now.** The sidebar ran a second, hand-rolled HTML5 drag for folder-onto-folder, with its own hit-testing, its own over-state and its own rules about what a row would accept — and only one of the two worked on a tablet.

**What a target accepts is static; whether _this_ drag may land there is not.** This took one attempt to get wrong. `targetProps` first carried a boolean the caller computed from the live drag, and the first `pointermove` both begins the drag and hit-tests — so React had not re-rendered and every target still carried the value it had while nothing was dragging. A flick that picked up and dropped in one movement landed nowhere. `data-lw-drop-kinds` is now a fixed description of the surface, and the cycle rule goes through a `canDrop` callback invoked with live values at hit-test time.

Drag remains an **accelerator, never the mechanism** (ADR 0007). There is no keyboard gesture for it and there is not going to be one, so every move it enables is also reachable from "Move to folder…" in the selection bar.

### 2. "Unfiled" is gone; the way out of a folder is not

The sidebar row, the `{ kind: "unfiled" }` filter, its drop target and the word itself are all removed. "All boards" already showed those boards; a second place that showed only them was a list that grows rather than shrinks.

**Deleting the row without keeping an exit would have made filing a one-way door** — no drop target, no menu entry, and a board that can go in but never come out. The "Move to folder…" picker therefore keeps a first entry, worded **Remove from folder**. The word goes; the exit does not.

Three independent spellings of the same idea — a drag key `" unfiled"`, a filter kind, and a `<select>` sentinel `"__unfiled"` declared **twice** in two components, with a test pinning the raw literal rather than any of them — collapse to one exported `NO_FOLDER`.

### 3. The path is the heading

`LawhaBreadcrumb.tsx` is deleted. There were three statements of where you are stacked above the first board: a breadcrumb strip, an `<h1>`, and the highlighted row in the tree. The ancestors are inline in the heading now, and the "All boards" crumb goes with the strip — it only ever duplicated the row already sitting at the top of the sidebar.

### 4. Share is people-first

Six headed sections became two, in the order every tool people already know uses: invite, then the roster, then "General access" with the link and its Copy button in the same block.

The ordering is an argument, not a convention. **Naming a person is the deliberate act; handing out a link is the blanket one**, and on a board that carries its key in the URL the blanket one should not be what the panel opens on.

**Presence merges into the roster.** "Who has access" and "Here now" sat four sections apart, so one person appeared twice — once with a role, once with a colour — and nothing said they were the same person. One row each, with a dot for the ones in the room. The dot is never colour alone: the row carries "here now" in its accessible name. Link guests have no membership row to mark, so they get a line of their own rather than being dropped for not fitting the table.

The join is on the **account** id. `collaborator.id` falls back to the socket id before `lawha-identities` arrives, so joining on it directly would compare a socket id to an account id — never matching, silently, showing a full room as empty. `useLawhaPresence` nulls that fallback rather than passing it on.

The row's `⋯` expands **in place** rather than opening a menu: a popover inside a popover inside a phone bottom sheet is exactly the shape invariant 11 is about.

Nothing here widens permission. Every mutating control stays owner-gated and the server enforces the same rule in four places (invariant 21).

### 5. Four sync defects, all silent

- **`broadcastScene` marked elements delivered before sending them.** It wrote `broadcastedElementVersions` and then awaited `_broadcastSocketData`, which is a no-op while the portal is closed — which is most of a reconnect. Anything drawn in that window was recorded as delivered and skipped by every later delta. `_broadcastSocketData` now reports whether it emitted.
- **A peer's `SCENE_INIT` after a reconnect was discarded.** `handleReconnect` re-arms `socketInitialized` after an _awaited_ HTTP read, so a peer's INIT — sent in answer to our own rejoin — landed late and fell out of the handler with no fallback. It is reconciled as an update now, which is safe rather than merely convenient: reconciliation is per element and never deletes.
- **`queueSaveToBackend` dropped a save it could not make.** lodash's throttle does not retry, so the trailing call was spent and the 5s window reset. It re-queues instead. Invariant 17 makes this load-bearing: local saving is paused for the whole session, so the server copy is the only durable one.
- **The dashboard never refreshed.** `reload()` ran once in a mount effect, so the board list was a snapshot of the moment the page opened; a rename, a new board or a share change made anywhere else never arrived. It re-reads on `focus` and `visibilitychange` behind a 3s floor — the dashboard is a page you _arrive_ at, and arriving is the event.

**One item from the plan was not a defect and was not "fixed".** `first-in-room` de-registers itself, so a reconnect landing alone in the room never re-runs that path — but `handleReconnect` is driven by `room-user-change`, which the relay emits unconditionally at join. The path is covered.

### 6. The laser's colour was frozen and theme-blind

`laserTrails.ts` built each peer's trail once and closed over the collaborator object from that moment. `Collab.updateCollaborator` replaces that object on every update, so a `colorIndex` arriving later never reached the trail — and it almost always arrives later, because a pointer event precedes `lawha-identities`. The peer's _cursor_, read from live state, showed the colour they chose; their laser showed a hash of their socket id, for the whole session.

The same line called `getClientColor` with **no theme argument** — the only such call site in the tree. The interactive canvas is inverted in dark mode, so that is not a shade out, it is the other colour. Exactly what ADR 0002 §3 exists to prevent, in the file ADR 0002 named.

Both are fixed on that one already-diverged line: read the collaborator from live state, pass the theme. **Invariant 10's count does not move** — still `laserTrails.ts`, still one site.

Two more, in app code: `resolvePointerColors` falls back to the server's announced `colorIndex` when the pointer carries none, so a guest's laser stops disagreeing with their cursor; and every peer's stored colour is re-resolved when the local theme flips. ADR 0002 accepted that staleness as unreachable because pointers stream at 30Hz — true only of a peer who is _moving_, and a trail lingers after they stop.

### 7. The canvas corner is empty

The sidebar trigger is hidden from `lawha-editor.scss`, and the shape library is reached from a "Shape library" item in the main menu through `setAppState({ openSidebar })` — a state change, not a portal, because `DropdownMenuContent` decides outside-clicks by containment and relocating a trigger breaks click-to-close.

`AppSidebar.tsx` is deleted outright. It existed only to add Comments and Presentation tabs whose panels were Excalidraw+ signup promos — a heart illustration, "14 days of free trial", and a link off this network. On a self-hosted team board, a tab that opens an advert for a product you cannot buy from here is worse than no tab. Removing the component does not remove the sidebar: `LayerUI` renders its own `__fallback`, so Search and Library are untouched.

## Consequences

- **jsdom implements no `PointerEvent`,** so `fireEvent.pointerDown(node, { button: 0, clientX: 3 })` fell back to a plain `Event` and **silently dropped every property**. A gesture then read `undefined` for all of them, and `button !== 0` is true for `undefined` — the handler returned before it started, failing in a way that looked exactly like a product bug. `setupTests.ts` polyfills it over `MouseEvent`.
- `document.elementFromPoint` returns null in jsdom and is stubbed per gesture. The code under test still has to find the attributes on what it is handed.
- Every fix here was **neutrality-checked**: break it, confirm the matching test fails. That caught one assertion that was worth nothing — a reconnect test counting emits, which passes against the bug too, because the broadcast still fires and merely carries an empty `elements` array. It decrypts the payload now.
- `LawhaSharePopover.tsx` went from 744 lines to four files under the house 200–400 rule. `resolveBoardId`, `LINK_OPTIONS` and the presence join moved to `shareModel.ts`, where the join is testable without an editor or a socket.
