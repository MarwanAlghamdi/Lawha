# ADR 0002 — A user's chosen colour reaches the canvas

**Status:** accepted **Affects:** `packages/excalidraw/types.ts`, `packages/excalidraw/clients.ts`, `packages/excalidraw/index.tsx`, `packages/excalidraw/laserTrails.ts`

## Context

ADR 0001 made every collaborator's colour come from a five-value palette, indexed by a hash of their user id. That kept the canvas cursor and the DOM avatar in agreement, which was the problem it set out to solve.

It left two things unfinished, both of which only became visible once there were real accounts to attach preferences to.

**The account's colour picker changed nothing.** Phase 2 added "Cursor colour" to the account page and stored the choice in `users.color_index`. Nothing ever read it: `getClientColor` hashed the id, so the colour you picked was not the colour anyone saw — including you.

**Your own laser was always red.** `LaserTrails` builds one trail per collaborator, colouring each from `collaborator.pointer.laserColor` or falling back to `getClientColor`. But the _local_ trail — the only one its owner ever draws — was constructed with `fill: () => DEFAULT_LASER_COLOR`, a hardcoded `"red"`. So everyone else saw your laser in your colour and you saw it in red, which makes "pick a colour for your laser" a setting with no observable effect for the person setting it.

There is no host-facing hook for either. Cursors and trails are painted inside the package, from state the package owns.

## Decision

Three additive changes to the package, and one to the wire format in app code.

1. **`Collaborator.colorIndex?: number | null`.** An explicit palette index, carried per collaborator. `getClientColor` prefers it and falls back to the id hash when it is absent or out of range — so the hash remains the default for everyone who has not chosen, and a malformed value off the wire cannot produce an undefined palette entry inside the renderer.

2. **`ExcalidrawProps.laserColor?: string`.** The colour of the local laser trail, read through on every frame rather than captured at construction, so changing it in account settings takes effect without a remount. Defaults to `DEFAULT_LASER_COLOR`. This is a prop — an extension point — rather than editor state, which keeps it out of `restore`, `appState` defaults, and the package snapshots.

3. **Indices travel on the wire, colours do not.** `MOUSE_LOCATION` carries `colorIndex` and `laserColorIndex`; the receiver resolves them against _its own_ theme. The interactive canvas is inverted by a CSS filter in dark mode, so each palette entry ships a pre-inverted hex — picking one at the sender would make every laser and cursor wrong for anyone on the opposite theme. This lives entirely in `excalidraw-app`.

Carrying the indices on the pointer payload, rather than announcing them once on join, is deliberate: a peer who arrives mid-session would otherwise never learn the colours of everyone already in the room.

## Consequences

`packages/` divergence grows from two files to four. All four changes are additive — a new optional field, a new optional prop, and a preference inside an existing function — so an upstream merge conflicts only if upstream touches the same lines, and nothing outside Lawha behaves differently when the new prop and field are absent.

The alternative for the laser was to put the colour in `appState`, which would have pulled in `restore.ts`, the app-state defaults, and every package snapshot. A prop was cheaper and is the documented way for a host to configure the editor.

One rough edge is accepted: a theme change leaves a remote peer's stored `laserColor` resolved for the old theme until their next pointer event. Pointers stream at 30Hz while the mouse is moving, which is exactly when a laser is visible, so the stale window is not reachable in practice.

## Amendment (ADR 0008)

Two of the three decisions above were correct and not reaching the screen, and the accepted rough edge turned out to be reachable after all.

**The trail's colour was frozen at creation.** `laserTrails.ts` builds one `AnimatedTrail` per peer and keeps it for as long as that peer is in the room, and its `fill` closed over the collaborator object from the iteration that created it. `Collab.updateCollaborator` builds a **new** object on every update, so decision 1's `colorIndex` never reached the trail once it existed — and it almost never exists first: a pointer event precedes `lawha-identities`, so the trail is created before the colour is known. The peer's cursor, which reads live state at paint time, showed the colour they chose; their laser showed the id hash. Same person, two colours, all session, and only the wrong one moved.

**Decision 3 was not applied at that call site.** `getClientColor(key, collaborator)` there took **no theme argument** — the only such call in the tree; `clients.ts:506` passes `appState.theme`. So every fallback laser resolved to the light `hex` on a canvas the dark theme inverts. Precisely the failure this ADR's third decision exists to prevent, in the file this ADR names.

Both are fixed on that same single line, which now reads the collaborator back out of `app.state.collaborators` and passes `app.state.theme`. **Invariant 10's count does not move.**

Two further changes live in app code rather than the package. `resolvePointerColors` falls back to the server's announced `colorIndex` when the pointer carries neither index — a link guest has no account to choose with, and a peer whose pointer left before `setPaletteChoices` ran has not sent one — so a laser stops disagreeing with the cursor above it. And `Collab.resolveAllPointerColors` re-resolves every peer when the **local** theme flips, which closes the rough edge accepted above: 30Hz is true only while a peer is _moving_, and a trail lingers about a second after they stop.

`excalidraw-app/tests/laserColorSync.test.tsx` pins all of it. Nothing did before — `LawhaLaserColor.test.tsx` covers the picker and stops at the wire, which is why two bugs on the receiving side survived this ADR.
