# ADR 0006 — Server-authoritative identity on the wire, and profile pictures on the cursor

**Status:** accepted **Affects:** `lawha-server/src/socket/identity.ts`, `lawha-server/src/protocol.ts`, `lawha-server/src/http/routes/users.ts`, `packages/excalidraw/clients.ts`, `excalidraw-app/collab/Collab.tsx`, `excalidraw-app/lawha/**` **Supersedes in part:** ADR 0003 (its "DOM-only pictures" decision and its "only your own picture can be shown" consequence)

## Context

ADR 0003 closed with two statements that were true when it was written and are the reason this one exists.

**"Only your own profile picture can be shown."** Excalidraw's collaborator map is keyed by socket id and carries a username, an idle state and a palette index. There is no account id on it, so there is nothing to fetch a peer's picture _by_. ADR 0003 named the fix — put a user id on the wire — and deliberately did not take it, calling it "a decision for whoever owns `Collab`".

**"Profile pictures are DOM-only ... a photograph put through `invert(93%) hue-rotate(180deg)` is not a photograph."** `.excalidraw__canvas.interactive` carries that filter in dark mode. The claim is about a _forward_ application of it and is correct as stated.

Two further things were wrong for want of the same missing id. `useLawhaPresence` deduped by `collaborator.id` so that one person with two tabs read as one person — but nothing ever set that field, so every tab counted as a stranger. And a link guest was indistinguishable from a signed-in viewer in the presence stack (roadmap known issue 15), because a guest is exactly a peer about whom the client knows nothing.

## Decision

### 1. Identity is announced by the server, on its own event

A new server→client event, `lawha-identities`, carries one row per socket in the room:

```
{ socketId, userId | null, username, colorIndex | null, avatarId | null, isGuest, canEdit }
```

It is emitted **alongside** `room-user-change`, never inside it. That event's payload is a bare array of socket ids and it is the client's own vocabulary — invariant 15 is precisely about not making the relay speak its own. It is always emitted _after_, because the client rebuilds its collaborator map wholesale from the membership array and identities merged first would be thrown away.

It is emitted on join, on leave, and unconditionally from `applyBoardAccessChange`. That last one is not redundant: access is re-checked rather than checked once (invariant 23), and the common outcome of a re-check is a **demotion with no eviction**, where the membership array does not change and `room-user-change` therefore says nothing at all, while `canEdit` has moved.

**The server is the only party that may say this.** Carrying a user id on the pointer payload — the option ADR 0003 sketched — would have been half the lines and a hole: pointer payloads are whatever the sender writes, so a link guest could assert somebody else's account and be handed their name and their photograph. The relay already holds each socket's authenticated principal.

**Announcing it is not the same as pinning it.** `Collab` keeps the last announced row per socket in `serverIdentities`, and `updateCollaborator` applies `pinnedIdentity()` **last** in its `Object.assign` chain — after the payload that caused the update. Without that ordering the announcement is merely _first_: pointer and idle payloads carry a `username` of their own, one arrives roughly every 33ms, and the later write wins. A link guest has no session, so the effect that seeds the collab username from the account never runs and the client falls back to `getRandomUsername()` while the server has named them `Guest Otter` — every peer watched the name flip on the guest's first mouse move, and the guest's own presence stack kept showing the server's name, because a sender never receives its own volatile broadcast. `getRandomUsername` also sits behind a dynamic `import()`, so a pointer sent inside that window carried `username: ""` and blanked the name outright.

A socket the server has not announced yet pins nothing, so a peer whose identity has not arrived still takes its name and colour from the pointer payload, exactly as it did before identities existed. "Not yet known" and "claimed" are different states and only the second one is a lie.

`avatarId` is withheld unless the account has a picture **and** has switched `avatar_on_cursor` on. Gated on the server, not filtered on the client, so the opt-in is a privacy contract rather than a rendering preference: a peer cannot learn your picture by ignoring a flag.

Withholding the id is necessary and is not sufficient. The bytes live behind `GET /api/users/:id/avatar`, and this very event hands every co-present peer's account id to every other peer, link guests included — so anyone willing to ignore the flag already held the one thing needed to ask for the picture directly. **That endpoint checks `avatar_on_cursor` itself**: your own picture always, anybody else's only when they have opted in, and `404` rather than `403` when they have not, because whether an account has a picture it has chosen not to share is itself not the caller's business and the two answers must be indistinguishable. Two doors on the same bytes, and for one phase only one of them was locked — see the Consequences.

### 2. The dark-mode filter is answerable, so pictures may be cursors

ADR 0003's objection was to applying the filter forward. Both halves of it are invertible, so the bitmap is **pre-imaged** instead: decoded once, transformed by the exact inverse of `invert(93%) hue-rotate(180deg)`, and cached. What the filtered canvas then paints is the original photograph.

`invert(a)` is the affine map `c' = c(1 - 2a) + a`, invertible at `a = 0.93`. `hue-rotate(180deg)` is an involutive 3×3 matrix — it is its own inverse, which is worth knowing before anyone tries to derive a second one. `preimageDarkCanvasPixel` in `clients.ts` is the pair, and `clients.test.ts` proves the round trip by reimplementing the CSS filter rather than transcribing a table, exactly as it does for the palette.

Out-of-gamut channels are clamped. The reachable range after the rotation is roughly 0.07–0.93 per channel, so a saturated red has no exact pre-image; the cost is accuracy on the most extreme pixels of a photograph.

The render path is the constraint that shapes everything else. `renderRemoteCursors` runs per frame per peer, so it **only ever reads a cache**: it never decodes, never awaits and never throws. A miss starts one background decode, answers null, and the crewmate is drawn for that frame. A failure is cached as `null` and never retried — without that, a 404 avatar starts a fresh request on every frame.

ADR 0003's third objection was that the render loop is not continuous, so an idle peer's picture would not appear until they moved. That is answered by `onCollaboratorAvatarReady`: `Collab` subscribes and republishes its collaborator map, which is one repaint per decoded image and none afterwards.

The avatar is always ringed in the collaborator's palette colour. A photograph carries no reliable identity on a canvas — it can be dark, busy, or a picture of a cat — and the ring is the same colour the DOM avatar, the name chip and the laser already use.

### 3. Guests are named, and marked

Every guest used to be called "Guest", which on a board with two of them is indistinguishable from one person with two tabs. `guestDisplayName` derives a stable placeholder from the guest pass id (`Guest Heron`, `Guest Otter`). It is obviously not an account name and carries no information about the visitor, which is the point: a link guest has told us nothing about themselves and we must not invent anything.

`isGuest` reaches the presence stack as a badge **and** as part of the accessible label. "Who am I sharing this board with" must not be visual-only.

## Alternatives rejected

**A user id on the pointer payload.** Cheaper and forgeable; see above. It also would not have carried `canEdit`, which has no other home.

**Widening `room-user-change` to an array of objects.** It is the client's event; `Collab.setCollaborators` reads it positionally. Invariant 15 exists because the relay diverged from the client's vocabulary once already and follow mode silently did nothing for a phase.

**Sending the avatar id to everyone and letting the client honour the opt-in.** A privacy control enforced by the party it protects other people from is not a control. Same shape as invariant 21.

**Gating the avatar endpoint on board membership instead of on consent.** "Anyone in a room with you may see your picture" is the rule the endpoint's old comment implied, and it cannot be evaluated there: the URL carries a user id and no board id, so there is nothing to check membership _of_. Threading a board id through would also make the answer depend on who is asking about what, which is a cache key nobody wants on a URL that is meant to be `immutable` for a year. Consent is the stronger check regardless — it is the person's own decision rather than an inference about who is entitled to look at them.

**Letting the client drop a peer's `username` from the pointer payload instead of pinning it in the merge.** That payload is upstream Excalidraw's, not ours (invariant 15), and it is the only name a peer has until an identity arrives. Removing the field would break the pre-identity path to fix the post-identity one; ordering the merge fixes only what is broken.

**Caching the identity on the socket at handshake.** A rename, a new picture or a flipped opt-in would then reach the room on the next reconnect rather than the next membership change. The lookup runs on membership changes only — never on the pointer path — so one query per member is affordable where one per message would not be.

## Consequences

- **`packages/` divergence stays at four files** (invariant 10). `clients.ts` was already one; `types.ts` gains one additive optional field, `Collaborator.isGuest`. `id` and `avatarUrl` already existed upstream.
- **`COLLABORATOR_PALETTE_SIZE` is 12 at last.** ADR 0003 recorded it as a hand-copied `5` and said half the wheel was unreachable until it was raised. It stayed at 5 for a phase — the laser picker paints twelve swatches and seven of them answered 400 — because the only test claiming to pin it lived on the client, where the server's constant is invisible. The bound is now asserted in `lawha-server/tests/integration/account.test.ts`, on the side of the wire that enforces it. **A duplicated constant is pinned where it is used, not where it is copied from.**
- **The identity source is a module singleton**, published by `createSocketServer({ identity })`, the same idiom as `liveAccess.ts`. It is optional: without it the event still carries socket id, user id, guest status and `canEdit`, and only the database columns are missing — which is a failure that throws nothing and that no relay-level test notices. `src/index.ts` passes `ctx.users`; that one line is the whole difference between the feature working and looking wired.
- **A peer's picture is now a cross-origin-free `GET /api/users/:id/avatar`** made by every member of the room, including link guests. It is the same URL the DOM avatar uses, so one browser cache entry serves the canvas cursor and the presence stack, and the `?v=<avatarId>` token that busts it is the same on both.
- **§1's `avatarId` promise was not true as built, and the contradiction was inside this document.** The bullet above used to end "that endpoint was already reachable by them", which is an accurate sentence that says, in company with §1, that the bytes we promised to withhold were fetchable by exactly the people we promised to withhold them from. The endpoint rested entirely on its address: a user id is 16 random bytes, so it cannot be walked, and one was only ever handed out alongside a `PublicUser` to somebody already seeing that person's name. `lawha-identities` retired that argument on the day it shipped by putting every co-present peer's account id into every other peer's hands. Withholding the id from the payload then bought nothing — the request was one line of `fetch` away, keyed on an id the same payload had just supplied. **This is invariant 21 in its usual costume: a permission enforced in one layer is not enforced.** It is worth saying which layers, because the count is the whole lesson — the promise was asserted in four places (`protocol.ts`'s `LawhaIdentity.avatarId`, §1 above, `identity.test.ts`, and the comment on the account panel's toggle) and **not one of them was the door**. Every one described what the relay declined to send; none of them described what the HTTP route would answer. The route now checks `avatar_on_cursor` for any caller but the owner, and `avatar.test.ts` pins the refusal, the opt-in, the owner's own always-allowed access, that a withheld picture is indistinguishable from no picture, that the ETag and 304 path still work once consent opens it, and that opting back out stops the bytes again.
- **A server-announced field is only as authoritative as the last write to it.** `lawha-identities` was correct on the wire and undone in the collaborator map: `updateCollaborator` merges with `Object.assign`, pointer and idle payloads carry a `username` and a `colorIndex` of their own, and the sender's packet is the one that arrives last. Moving a fact to the server settles **who may state it**, not **who may overwrite it** — the client still has to refuse the write, which is what `pinnedIdentity()` at the end of the merge does. `lawhaIdentityPinning.test.tsx` pins the direction that was broken (a payload arriving second must not overwrite what the server said, for names, colours, account id, guest flag and picture alike, and for the whole pointer stream rather than only its first packet); `lawhaIdentity.test.tsx` pins the opposite, harmless direction, and it is worth not confusing the two, because for a while the roadmap cited the harmless one as proof the dangerous one was covered.
- The avatar bitmap cache is keyed `(url, theme, pixelSize)` and is unbounded. Bounded in practice by the number of distinct peers a tab sees; if that ever stops being true, the eviction policy is LRU on the map, not a smaller key.
