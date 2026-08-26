# Lawha — state of the build and the road ahead

Written at the end of Phase 1 and updated at the end of every phase since — currently Phase 5 — so a later session can pick this up cold. Section 2 is the part to read first; §4.17 is the most recent batch — the escrow's second half — and §4.12 is the review pass that is still the best example of how this project reads its own claims.

For how to run and configure it, see `README.md`. For the architectural invariants and design decisions, see §2 below.

Branch: `main`. Base: upstream Excalidraw, reachable as `upstream/master` once you add the remote — a fresh clone has neither. The development history that produced all of this was squashed into `main`'s single commit; it is kept locally on the `lawha` branch and the `archive/lawha-dev-history` tag, and was never published.

---

## 1. What exists today

**All five screens.** `/` is the dashboard once signed in and the canvas otherwise, `/b/<id>` is a board, and `/signin`, `/signup` and `/account` are real routes.

| Mockup | State |
| --- | --- |
| Lawha Canvas | Built — full-bleed, consolidated, live collaboration |
| Lawha Sign In | Built — username + password, no email |
| Lawha Sign Up | Built — display name + password, no email |
| Lawha Account | Built — twice: a dialog inside the canvas, and `/account` |
| Lawha Home (board dashboard) | Built — the landing page, with live thumbnails of each board |

Screenshots: `../screenshots/` (Phase 1) and `/tmp/lawha-phase2-shots/` (Phase 2 — auth, account, AI panel, both themes, three viewports).

### Backend — done, and more complete than the UI

`lawha-server/` is a yarn workspace: socket.io relay + REST + SQLite + on-disk files, plus `scripts/` for the operator tools (backup, restore) and their `node:test` suites. Measure the test counts, do not recall them — they moved twice while this paragraph was being written. The whole REST surface, as mounted in `src/http/app.ts` — everything below has a UI now except `GET /api/admin/config` (known issue 19) and `/api/metrics`:

```
POST   /api/auth/register        {username, password}   -> 201 + session cookie
POST   /api/auth/login           {username, password}
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/password        {currentPassword, newPassword}
PATCH  /api/auth/me              {username?, colorIndex?, laserColorIndex?, avatarOnCursor?}
DELETE /api/auth/me              {password}             -> 204, cascades
GET    /api/auth/config          -> {requireAuth, allowOpenRegistration, hasMasterPassword}

PUT    /api/users/me/avatar                             -> raw image bytes; type sniffed, never trusted
DELETE /api/users/me/avatar
GET    /api/users/:id/avatar                            -> yours always; anyone else's only if they set
                                                           avatar_on_cursor. 404, never 403, on refusal

GET    /api/auth/reset/:code                            -> {code, username, locked, expiresAt};
                                                           unauthenticated — whoever holds the code is
                                                           somebody who cannot sign in
POST   /api/auth/reset/:code     {newPassword}          -> sets it, spends the code, revokes every session,
                                                           signs them in. The code is the whole credential

GET    /api/admin/config                                -> what this server is doing
GET    /api/admin/users                                 -> admin or master session
POST   /api/admin/users/:id/reset-code  {lock}          -> {code, expiresAt, revokedSessions}; shown ONCE,
                                                           one hour, single use, and recalls that account's
                                                           earlier codes. Replaces the removed set-password
                                                           route, which now 404s (ADR 0021)
POST   /api/admin/users/:id/admin     {isAdmin}

GET    /api/boards                                      -> boards for this user
POST   /api/boards               {id?, name?}
GET    /api/boards/:boardId                             -> board + members
PATCH  /api/boards/:boardId      {name?, linkAccess?, tagIds?, folderId?}
POST   /api/boards/:boardId/duplicate                   -> ciphertext copied verbatim, rev restarts at 1
POST   /api/boards/:boardId/access                      -> the ONLY unauthenticated route: "may I open
                                                           this?", and a board-scoped pass if yes
DELETE /api/boards/:boardId                             -> soft delete

GET    /api/boards/:boardId/members
GET    /api/boards/:boardId/members/candidates
PUT    /api/boards/:boardId/members/:userId  {role}
DELETE /api/boards/:boardId/members/:userId

GET    /api/boards/:boardId/scene                       -> ciphertext + rev
PUT    /api/boards/:boardId/scene                       -> CAS write

GET    /api/tags                                        -> per-person, never shared
POST   /api/tags                {name, color?}
PATCH  /api/tags/:tagId
DELETE /api/tags/:tagId

GET    /api/folders                                     -> this account's folders + counts
POST   /api/folders             {name}                  -> 201, 409 FOLDER_TAKEN
PATCH  /api/folders/:id         {name}                  -> 404 if not yours, 409 on a clash
DELETE /api/folders/:id                                 -> 204; its boards are unfiled, never deleted
PATCH  /api/boards/:boardId     {folderId: string|null} -> files it for THIS caller only

POST   /api/files/:scope/:containerId/:fileId
GET    /api/files/:scope/:containerId/:fileId

GET    /api/health
GET    /api/metrics                                     -> Prometheus text
```

Two claims that used to live here are gone because they stopped being true: the test count (88, then 245, now 255 — measure it, do not recall it) and "endpoints that exist and are unused by any UI" — `board_members` and `tags` both have routes and screens now. Migration count is at 005.

### Frontend — done

- Design system: `excalidraw-app/lawha/styles/` — `--lw-*` tokens (light+dark), self-hosted fonts, the bridge onto Excalidraw's own custom properties, `.lw-btn` / `.lw-pill` / `.lw-chip` / `.lw-island` primitives, focus rings. **The Home board cards and the auth cards are already expressible in these.**
- Editor skin: `lawha/styles/lawha-editor.scss` (pure CSS).
- Canvas chrome: `lawha/chrome/` — top bar, board title (inline rename), save status, presence stack, theme toggle, account button, overflow sheet, logo, sync pill. Share popover in `lawha/share/`.
- Storage: `excalidraw-app/data/storage/` replaced Firebase entirely.
- Board metadata client: `excalidraw-app/data/boards.ts` (best-effort, never throws).

---

## 2. Invariants — do not break these

Each of these was learned the hard way; several were live bugs.

1. ~~**The _plaintext_ room key never leaves the client.**~~ **RETIRED by ADR 0012.** Kept numbered rather than deleted, because the other twenty-four are cited by number all over this repo and renumbering them would silently rewrite every one of those references. The history, since it is the most-amended rule here: it read "the plaintext room key never leaves the client"; ADR 0010 amended it to "a wrapped copy is escrowed"; ADR 0011 to "the server holds a wrapped copy it can open"; ADR 0012 removed the encryption, so there is no room key left to make a claim about. **What replaces it is invariant 21**, which was one guarantee among several and is now the only one. Note what did NOT change: the server still does not merge, so invariant 2's compare-and-swap stands on its own reasoning — merging is per element and lives in the editor.

   **Amended by ADR 0010.** A _wrapped_ copy of every board key is now escrowed server-side, encrypted in the browser under a key derived from the account password via PBKDF2. The server holds a locked box and has never held the key to it, so everything above still holds. The amendment was forced by the per-origin scoping of that keystore: `https://lawha.local`, a Tailscale address, a LAN address and `localhost` are four disjoint vaults for one person on one laptop, and a real board became permanently unreadable with 12 KB of scene and a 2.4 MB image sitting intact on disk. The cost is written down in the ADR rather than hidden here — database theft plus a cracked password now yields that account's boards, where before it yielded nothing.

2. **Never last-write-wins on `sceneVersion`.** It is a sum of element versions, so a client holding _fewer_ elements can produce a _larger_ value. Conflict resolution is compare-and-swap on the server-owned monotonic `rev`, with the client merging on 409 (`data/storage/lawha.ts`).
3. **Never throttle `broadcastElements`.** It is unthrottled by design and is what meets the <500ms sync target. `SYNC_FULL_SCENE_INTERVAL_MS` governs only the redundant full resync and persistence.
4. **`Portal.socketInitialized` gates both sending and accepting `SCENE_INIT`.** Clearing it to accept an INIT also silences the client. If you clear it, you must set it back.
5. **The relay drops broadcasts from a socket not in the room.** After a reconnect the transport returns well before `join-room` completes, so any post-reconnect sync must wait for `room-user-change`.
6. **`useEditorInterface()` is stale for host children.** `App.refreshEditorInterface` writes a plain instance field, not React state, so the context only updates on App's next render. Use `lawha/hooks/useLawhaFormFactor` instead — it measures the container itself with the package's own `getFormFactor`.
7. **Do not add `@font-face` to `packages/excalidraw/fonts/fonts.css`.** Its contents are string-replaced at build time; anything added there works in dev and vanishes in production. Fonts load from `lawha/fonts.ts`.
8. **The token bridge must be emitted at two specificities.** `theme.scss` re-declares properties under `.excalidraw.theme--dark` (two classes), which outranks a single `.excalidraw` selector. See `lawha-bridge.scss`.
9. **No email. Anywhere.** Not in the schema, DTOs, or error text. A column existed for a few hours and was removed again in migration 003 — on a private network the recovery path is a phone call to the administrator, not a link in an inbox. Recovery is the admin panel, `LAWHA_MASTER_PASSWORD`, or `yarn --cwd lawha-server reset-password <user>`. Do not add SMTP. There **is** a reset link now (`/reset/<code>`, ADR 0021) and it does not weaken this: nothing sends it, the administrator hands it over by hand, and no address is stored to send it to.
10. **`packages/` divergence is fourteen paths, and every addition needs an ADR.** (Thirteen until ADR 0019, which accounts for the fourteenth in its own header; this line had not been updated to match. Measured at 14 files / 2,332 insertions on 2026-08-18 — and the point of the rule is that you re-run the command rather than trust either number.) The list lives in known issue 20 and is measured, not recalled — `git diff --stat $(git merge-base upstream/master main)..main -- packages/`. Nine are for collaborator and laser colour (`docs/adr/0001`, `0002`, `0003`, `0006`); four are the pan momentum and right-drag (`docs/adr/0013`). The point was never the number, it is that upstream merges stay tractable — so weigh **where** an addition lands: a new file upstream does not have costs nothing at merge time, an edit to `App.tsx` costs the most. Do not add to the edited-file side without recording why.
11. **A phone bottom sheet must not be Radix popover content.** Radix's wrapper carries a `transform`, which becomes the containing block for `position: fixed` descendants, so `inset-inline: 0` collapses to the popper's zero-width box. `lawha/chrome/LawhaPanel.tsx` renders sheets directly into the editor container instead; put new panels through it.
12. **Sheet rules are compound selectors (`.lw-ai.lw-ai--sheet`) on purpose.** A single-class rule ties with `.excalidraw .lw-ai`, and the winner would then depend on import order — which silently gave the sheet the popover's 330px width.
13. **The account form is keyed on `user.id`.** Initialising its fields from a possibly-null user and syncing in an effect left one frame where the name field was empty while "Save changes" was enabled — one click from PATCHing an empty username.
14. **Never serve the dev server over a tunnel.** Vite hands the browser ~885 module requests; each pays the WireGuard round trip and the canvas takes most of a minute. `yarn lan` builds and serves from lawha-server — 20 requests, one origin, no proxy.
15. **The relay speaks the client's vocabulary, not its own.** `user-follow` carries `FOLLOW`/`UNFOLLOW`; the relay originally matched `SUBSCRIBE`/`UNSUBSCRIBE` and fell through to `leave` for everything else, so following silently did nothing. Its tests missed it by using the server's spelling. When adding a socket event, assert against what `packages/` actually sends.
16. **Colours cross the wire as palette indices, never as hex.** The interactive canvas is filtered in dark mode, so which of an entry's two hexes is right depends on the _receiver's_ theme.
17. **`LocalData.pauseSave("collaboration")` is active during a session**, so the server copy is the only durable one. "Saved" must mean the write landed.
18. **Lawha needs a secure context. There is no plain-HTTP LAN deployment.** **The rule survives ADR 0012 and its reason moved — do not delete it on the grounds that the encryption is gone.** It used to be that every board key was minted with `window.crypto.subtle`. No key is minted now, but `generateIdFromFile` still computes every image's id with `crypto.subtle.digest` (`packages/excalidraw/data/blob.ts`), and browsers withhold `crypto.subtle` outside HTTPS and `localhost` exactly as before — on `http://192.168.x.x` it is simply `undefined`. The old failure was "Cannot read properties of undefined (reading 'generateKey')" at board creation; the current one is the same shape at image insert. What is no longer true is the sentence that used to follow: the product's premise is not end-to-end encryption. Dev servers for LAN or tailnet testing set `LAWHA_HTTPS_KEY` / `LAWHA_HTTPS_CERT` (see `certs/`, gitignored); a real deployment terminates TLS properly.
19. **No `window.alert`, `confirm` or `prompt` on any path the app can reach on its own.** A native dialog blocks the renderer's main thread until it is dismissed; fired from somewhere the user did not ask for it, that is a frozen tab, and it took three sessions to find the last one. User-initiated confirmations on the dashboard are the exception, and even those are on the list to replace.
20. **Nothing may read the scene back out of the editor during teardown.** By `componentWillUnmount` the editor above has gone and returns an empty scene; persisting that overwrites the board. `Collab.leaveRoom` flushes `lastSyncedElements` instead.
21. **A permission enforced in one layer is not enforced.** **Since ADR 0012 this is the only thing protecting a board — there is no encryption behind it, so a hole here is the whole failure rather than half of one.** `canEdit` existed for months with zero call sites, so `link_access: "view"` granted full write, byte-for-byte identical to `edit`. It is now checked in **four** places that must move together: the scene write, the relay's broadcast path, the client's view mode, and the image upload in `lawha-server/src/http/routes/files.ts`. Removing any one of them re-opens the hole silently, because the others keep the UI looking correct. The fourth was added late and is the invariant restating itself: `POST /api/files/rooms/:boardId/:fileId` asked only "can you access this board", so the same viewer whose scene write `scene.ts` refused could still write up to 4 MiB into that board's file directory and get a `files` row credited to them. Nothing failed; the UI looked correct throughout.
22. **A link visitor is a narrower principal than a signed-in user, not an absent one.** **Amended by ADR 0024:** the owner may now widen a visitor's *role* to editor, per board, with a fourth link option that is off by default. The **scope** is untouched and is the half that was load-bearing — a pass is still pinned to one board by `guestBoardId`, and `principalOf` still fails closed. Read the sentence below as "read-only unless the owner has said otherwise for this board". Refusing anonymous connections outright made every share link useless without an account; handing them the shared `anonymous` identity would let guests co-own each other's boards. The middle is a server-minted principal scoped to one board, read-only. Never widen it by flipping `LAWHA_REQUIRE_AUTH`.
23. **Access is re-checked, not checked once.** It used to be resolved only at `join-room`, so revoking someone did nothing until they reloaded — and because local saving is paused during collaboration, everything they drew in between went nowhere.
24. **The client must know what the server will refuse.** Enforcement alone is not enough: a viewer whose save is correctly rejected was shown "Couldn't save to the backend database", which reads as a broken product rather than an access level. Guard the funnel (`saveCollabRoomToBackend`), not the call sites.
25. **Opening `/b/<id>` joins its room whichever way it was reached** — share link or dashboard. If the two disagreed, the same board would be a live document one way and a local-only copy the other, and work on the local copy would be stranded.

---

## 3. Phase 2 — auth, routing, and the AI section — **done**

### 3.1 Routing

`excalidraw-app/routes/` — `router.tsx`, `LawhaProviders.tsx`, `SessionGate.tsx`.

- `react-router-dom@7`. `index.tsx` renders `<LawhaRouter />`.
- `App.tsx` exports `ExcalidrawWrapper` and no longer has a default export. The providers it used to own — `TopErrorBoundary`, the jotai `Provider`, `ExcalidrawAPIProvider`, and the new `AppThemeProvider` — moved to `LawhaProviders`, above the router, so navigating to `/account` and back does not rebuild the store or reset the theme.
- `/` and `/b/:boardId` are both the canvas. `/` is **not** the dashboard: Home is Phase 3, and routing to a page that does not exist would be a regression dressed as progress. `*` falls through to the canvas for the same reason.
- `/excalidraw-plus-export` stays outside the providers, as it was.
- Guards: `RequireSession` on `/account` (carries `from` so sign-in returns you there), `RedirectIfSignedIn` on `/signin` and `/signup`.
- The `initializeScene` hazard held: `replaceState` still preserves the pathname, and the two-browser test below passes unchanged with the router in place.
- `vercel.json` rewrites extended. `docker/nginx.conf` already had a catch-all.

### 3.2 Sign In / Sign Up

`excalidraw-app/lawha/auth/` — `SignInRoute`, `SignUpRoute`, `authApi.ts`, `useLawhaSession.ts`. Page chrome in `lawha/pages/`.

- **No email field.** The mockups had one; there is no email column, no mail flow, and nothing to put in it. The username _is_ the display name — inventing a second identifier with nothing behind it would have been worse than the mockup's asymmetry. A test pins the field's absence.
- `useLawhaSession()` is a jotai atom plus a module-level in-flight promise, so the several components that need identity share one `/auth/me`.
- `GET /api/auth/config` tells the UI whether registration is open; when it is not, sign-in hides "Create one" and `/signup` says so rather than offering a form that will 403.
- `LAWHA_REQUIRE_AUTH` was **left at `false`** rather than flipped. The app now handles both: signed out, the top bar shows "Sign in" and the canvas still works anonymously. Flipping it is a deployment decision, not a code change, and flipping it by default would have broken the running tailnet setup.

### 3.3 Account

`excalidraw-app/lawha/account/` — `LawhaAccountPanel` (the content), `LawhaAccountDialog` (in-canvas), `LawhaAccountRoute` (`/account`).

- **Rendered in two places on purpose.** The brief puts account settings inside the consolidated canvas UI, so the normal route in is a dialog over the editor — navigating away would unmount the editor and tear down a live session. `/account` renders the same panel in a page shell for arrivals with no canvas (a bookmark, and the Phase 3 dashboard).
- Profile: rename, cursor colour by `COLLABORATOR_PALETTE` index (never a hex — the palette carries two, and dark mode's canvas filter needs the other one).
- Change password, sign out, delete account with password re-confirmation.
- **The "Your data" card was dropped**, not deferred silently: export-all and import need the board list, which is Phase 3. It belongs with Home.
- "Side of the stack" dropped — no column, no meaning.

### 3.4 The AI section

`excalidraw-app/lawha/ai/LawhaAIMenu.tsx`. One "AI" control in the top bar opening a panel that lists every AI feature disabled with a `soon` badge.

Deleted with it: `components/AI.tsx`, `data/TTDStorage.ts`, the `<TTDDialogTrigger />` chip, and `VITE_APP_AI_BACKEND` from both env files. Those pointed at `oss-ai.excalidraw.com`, a hosted service a self-hosted Lawha cannot reach and should not be sending drawings to. Live buttons that fail on click are worse than an honest "soon".

### 3.5 Bug found by screenshotting, again

The phone bottom sheets were Radix popover content. Radix wraps content in an element carrying a `transform`, and a transformed ancestor becomes the containing block for `position: fixed` descendants — so `inset-inline: 0` resolved against a zero-width popper box and the sheet rendered 34px wide, off-screen. **This was already broken for the share sheet in Phase 1**; the AI menu only made it visible.

Fixed by `lawha/chrome/LawhaPanel.tsx`: on a phone the sheet is rendered directly into the editor container with no popper at all, which is also the honest model — a bottom sheet has no anchor. Both panels now share it.

### 3.6 Follow-up round (after Phase 2 feedback)

Five things came back from using it, and three of them were real bugs.

- **Tailscale was slow because it was the dev server.** 885 requests and 18.4MB per cold load. `LAWHA_STATIC_DIR` makes lawha-server serve the built app, and `yarn lan` wires it up: 20 requests, 2.9MB, canvas in ~250ms, one origin, no proxy. **`.env.production` also still pointed the socket at `oss-collab.excalidraw.com`** — any production build would have collaborated through Excalidraw's hosted relay.
- **The theme toggle left the canvas.** It lives in the editor's own main menu, which also offers the system option this one could not. Where a toggle remains (the auth and account pages) it now names the theme you are _in_ rather than the one you would move to.
- **The account colour picker changed nothing.** `getClientColor` hashed the socket id and never read the stored index. Indices now ride on every pointer broadcast and are resolved against the _receiver's_ theme. See ADR 0002.
- **Your own laser was hardcoded red.** Remote trails were already per-user; the local one was not, so the colour you picked was the one colour you never saw. New `laserColor` prop.
- **Follow mode never actually followed.** The client sends `user-follow` with `action: "FOLLOW"`; the relay matched `"SUBSCRIBE"` and fell through to `leave`, so the follower silently never joined the room and the followee never started broadcasting its viewport. The relay's own tests missed it by speaking the server's vocabulary rather than the client's.

### 3.7 Recovery, reversed twice

Email was added — column, required field, reset tokens, SMTP with a log fallback — and then removed again the same day. The deployment is a private network with an administrator on the other end of a phone, so:

- **Admin role.** First account on a fresh server gets it; `LAWHA_ADMIN_USERNAME` promotes on boot; the last one cannot be demoted.
- **Admin panel** in account settings: list accounts, set a password, grant or revoke the role. Setting a password revokes every session that account had.
- **Master password.** `LAWHA_MASTER_PASSWORD` signs in as any account, and the sign-in screen now offers it explicitly: a checkbox, rendered only where `GET /api/auth/config` says `hasMasterPassword`, that sends `master: true` on the login body. Ticked, the account's own password is not tried at all — which is the only way somebody whose own password happens to equal the master one can get a `via_master` session. Unticked, the behaviour is exactly what it always was: tried second, same argon2 cost, session flagged `via_master`, logged on the server and stated plainly in that session's UI. The reason for making it visible is that a credential with these consequences was previously used _by accident_, with nothing on screen saying so until afterwards. Every master verification also spends from one global budget of 10 per 15 minutes — see §4.14 for why the username-keyed and address-keyed limiters could not cover a credential that has no username.
- **Password floor is 8**, and the rules are now _visible_: a live checklist under the field, plus a confirmation field. They were always enforced; nothing said so until you tripped them, which is why they read as absent.

Migration 003 drops the email columns rather than rewriting 002, which had already run against a live database.

---

## 4. Phase 3 — Home dashboard

The last screen. Mockup: `Lawha Home.dc.html`.

### 4.1 Backend — **done**

| Need | State |
| --- | --- |
| List boards, with tags and live editor counts in one call | `GET /api/boards` |
| Rename, sharing, tag assignment | `PATCH /api/boards/:id` (`tagIds` replaces wholesale) |
| Delete | `DELETE /api/boards/:id` (soft) |
| Duplicate | `POST /api/boards/:id/duplicate` |
| Tags CRUD | `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id` |
| Live editor counts | `editing` map on the board list, from a socket-side presence registry |
| Thumbnails | **not built** — see 4.3 |

Notes worth keeping:

- **Tags are per-person.** Two people can both have "design" and they are different rows. A shared vocabulary would mean one person renaming a tag silently relabels everyone else's boards. `PATCH` drops tag ids the caller does not own.
- **Duplicate copies ciphertext verbatim**, keeping the source board's key — the server has never held a key, so producing a copy under a new one is not something it _could_ do. `rev` restarts at 1 so the copy has its own CAS history. Sharing is not inherited: a copy of a shared board starts private.
- **Presence is in memory and not persisted.** It describes connections, not data; a restart drops every socket, so a stored copy could only ever be wrong.

### 4.2 The blocker: scenes are stored under one global key

`LocalData` writes the scene to `localStorage["excalidraw"]` — one key for the whole app, not one per board. Open board B after board A today and you would see A's elements. **Nothing in the dashboard can ship until this is fixed**, and the fix is a design decision, not a refactor.

The proposal, which reuses machinery that already exists and is tested:

1. Every board gets an AES-GCM key at creation, exactly like a collaboration room key.
2. The key is stored locally, in an IndexedDB keystore mapping `boardId → JWK`.
3. Scenes always go to the server through `data/storage/lawha.ts` — the encrypted CAS write — whether or not anyone else is in the room. `LocalData`'s global key becomes an offline cache, or is retired for board routes.
4. Opening `/b/<id>` takes the key from the keystore, or from `#key=` in the URL when arriving by a share link. Duplicating copies the keystore entry alongside the board.

**The cost, stated plainly:** a board opened on a device that does not hold its key cannot be decrypted, and the server cannot help — that is what end-to-end encryption without key escrow means. Your board list will show boards you cannot open until the link reaches that device. The alternative is dropping E2E, which contradicts invariant 1.

This is worth a decision before building on it. If E2E is negotiable for private (non-shared) boards, a much simpler design becomes available: store those unencrypted and encrypt only on first share.

### 4.3 Thumbnails — solved without storing one

The original plan was a PNG per board, encrypted before upload and decrypted for display, because the server cannot render a scene it cannot read. That is still true, but it turned out not to be necessary: `lawha/home/boardThumbnail.ts` fetches the board's ciphertext, decrypts it with the key already in this device's store, and lays the element bounds out as positioned boxes. No PNG, no upload, no new column — the same end-to-end story as everything else, and nothing extra for the server to hold.

It is a sketch rather than a render: bounding boxes, stroke and fill only, capped at 60 elements, no text, freedraw or images. `thumbnail_path` remains unused, and a real render is only worth building if the sketch proves too coarse to recognise a board by.

### 4.4 UI — built, and now the landing page

Decision taken: **encrypt everything, one key per board, no escrow.** The server never holds a key, and the cost is accepted — a board is unreadable on a device that does not hold its key, and the dashboard says so on the card rather than failing at open time.

Built and committed:

- `data/boardKeys.ts` — IndexedDB `boardId → key`. The link wins over the store, because arriving at `/b/<id>#key=<k>` is how a board first reaches a device and how someone recovers one on a machine whose store was cleared. Every read degrades to null rather than throwing. 17 tests.
- `data/currentBoard.ts` + board-scoped `LocalData` keys. This is the fix for "open board B, see board A's elements".
- `routes/BoardRoute.tsx` — resolves the key and sets the current board id _before_ the editor mounts, then renders the canvas or a "locked here" panel.
- `lawha/home/` — the dashboard: grid, cards, search, segmented filter, sort, tag pills, new-board tile, rename/duplicate/delete. Phase 5 added a folder rail, multi-select (click, shift-click, "Select all N") and a bulk bar that exports, files or deletes the selection. "Export all" is gone: it was the wrong shape once a selection existed, and an export that silently omits the boards this device holds no key for is a backup with holes in it. The report names every skip.

### 4.5 The wedge — found, and it was never a loop

`/` is the dashboard now. What used to happen: sign in, go to Home, click a board, and the tab froze.

**It was `window.alert`.** `getBoardLinkData` alerted "Encryption key must be of 22 characters" whenever a `/b/<id>` path arrived without a `#key=` fragment — and opening a board from the dashboard does exactly that, because the key is already on the device and putting it in the URL would add nothing. A native dialog blocks the renderer's main thread until it is dismissed, and with the dialog off-screen or suppressed that is indistinguishable from a hang.

Three sessions of profiling missed it because every tool used agreed the main thread was blocked, and none of them said _why_:

- `Runtime.evaluate` hangs, `Profiler.stop` cannot complete, `Debugger.pause` never lands. All true of a blocked thread; none of them distinguishes a loop from a modal.
- What found it was **listening to every CDP event instead of the ones expected**. `Page.javascriptDialogOpening` had been firing the whole time, filtered out of the log by a handler that only knew about crashes and exceptions. _Log the unfiltered stream first; narrow afterwards._

The fix is three changes:

1. **`getBoardLinkData` is a pure function.** A missing fragment is not an error — the key is looked up for the open board instead (`data/currentBoard.ts` now holds it, published by `BoardRoute` before the editor mounts). A genuine failure still has a home: the board route's "locked here" panel, which does not block anything.
2. **`isCollaborationLink` is derived from the parser** rather than re-matching the URL. They could previously disagree — a `#key=` of the wrong length made one true and the other null.
3. **Opening `/b/<id>` always joins its room**, whether reached by link or by dashboard. Otherwise the same board is a live document one way and a local-only copy the other, and work drawn on the local copy is stranded.

**Two further bugs fell out of verifying the fix**, both of which only exist because boards are routes now:

- `Collab` never tore down on unmount — upstream never had to, since the canvas was the whole document. The socket stayed open, so the dashboard counted you as editing a board you had left, and the next board added a second socket.
- The obvious teardown — call `stopCollaboration` — **destroyed the board**. It flushes by reading the scene back out of the editor, but by `componentWillUnmount` the editor above has already gone and hands back an empty scene, which is then written over the real one. Caught by a test that compared the stored ciphertext, not by anything on screen. `leaveRoom` flushes the last elements that went past `syncElements` instead, and the save interval dropped from 20s to `SAVE_TO_BACKEND_INTERVAL_MS` (5s) so there is less to lose in the first place.

**A methodology note, because it cost hours.** Four things masqueraded as bugs and all four were mine: a Puppeteer `protocolTimeout` shorter than the waits it governed; the old 5/hour registration limit, exhausted by my own test runs; a "drew a rectangle" assertion that counted `<canvas>` elements, which exist on an empty board, so it passed while nothing was drawn; and a drag fired in a single tick, which leaves a zero-size shape that `getSyncableElements` correctly drops as invisible — indistinguishable from a broken save. **Assert on the artefact, not on a proxy for it:** painted pixels, element dimensions, stored ciphertext length.

## 4.6 Phase 4 — the ten-feature batch — **done**

Ten requested features, built by seven parallel agents with file ownership assigned by exact path. Recon ran first, deliberately, because three of the ten asserted something was broken. Two of those three were not, and the recon round paid for itself several times over.

**What was actually broken, that nobody had asked about:**

- **Share links did not work at all.** A board created from the dashboard gets `link_access: 'none'`, and the path that opens a room to link holders is skipped when you arrive already holding a key, so every recipient got a 403. This had shipped _and been tested around_: an earlier verification set link access manually over the API first, so it passed against a bug it never touched.
- **`link_access: "view"` granted full write** — invariant 21.
- **Revoking access did nothing** — invariant 23.
- **Docker had never built.** `.dockerignore` excluded `lawha-server/` itself.
- **No image had ever been uploaded to this server** — zero rows, no files directory.

**Two claims in this file were false when they were written**, both mine: the auth default, and "no native dialogs remain", which was true of the dashboard and generalised without checking.

### 4.7 Silence is the bug

The image pipeline was exercised hop by hop against a real server and works. What made it look broken is that every failure was invisible: a rejected upload was swallowed rather than thrown, one oversized file killed its whole batch, and a single failed fetch was never retried _and_ wrote `status: "error"` onto a shared element — so one peer's transient failure poisoned the board for everyone, permanently, because only `saved` elements are ever re-fetched.

The lesson generalises past images. Three features here were reported as broken and were really failing without saying so. When a subsystem has no way to report a failure, its failures present as absence — and absence gets reported as a different bug entirely.

### 4.8 Deliberately not built as asked

- **A continuous colour wheel.** Colours cross the wire as palette indices (invariant 16); an arbitrary hex has no dark-mode counterpart, so cursors and lasers would render wrong for every dark-theme peer. Shipped a 12-entry palette in a wheel layout.
- ~~**Profile picture as the canvas cursor.**~~ **Built in Phase 5, and the measurement above was wrong about the first of its three obstacles.** The dark-mode filter _can_ be cancelled from inside the canvas: both halves of `invert(93%) hue-rotate(180deg)` are invertible, so the bitmap is pre-imaged before it is drawn rather than corrected afterwards. The other two objections were real and were answered rather than dismissed — there is a bitmap cache now, keyed `(url, theme, pixelSize)`, and a decoded avatar notifies `Collab`, which republishes the collaborator map so an idle peer's picture appears without them moving. Opt-in per account, off by default: the server withholds the avatar id from anyone who has not opted in **and** the endpoint holding the bytes refuses them too — the second half arrived in §4.12, and without it the first half bought nothing. ADR 0006.
- **Unlocking `/admin` with the master password.** It is a login credential, not a page unlock. Still true after §4.14 and after ADR 0009, both of which moved the _screen_ and nothing else: `/admin` now shows `LawhaAdminGate`, which asks for a **username** alongside the master password because `POST /api/auth/login` refuses outright when the username does not resolve — a credential that authenticates against the server leaves nobody to attribute the next administrative action to. Typed alone into `/admin` it does nothing. The decision is unchanged; what ADR 0009 changed is who gets told the page is there.

## 4.9 Phase 5 — one config file, a way in, and identity on the wire — **done**

Five parallel build agents and an integrator, file ownership assigned by exact path, same shape as Phase 4. The request behind it was short — "show admin credentials and give me a config so I can fill in my settings in docker and run it fast" — and it turned out to name the two things that made self-hosting this genuinely hard.

**Getting in.** Self-hosting Lawha used to mean reading `src/config.ts` to discover that the first person to register becomes the administrator. That is fine when the operator is also the first user and useless otherwise: with open registration closed, an empty database is a locked door with nobody on either side of it. `lib/firstBootAdmin.ts` now creates one administrator when — and only when — the server has no accounts, and prints a generated 24-character password once, in a box, on stdout. Three rules it keeps, each of which is the interesting part:

- **Idempotent and silent when it does nothing.** A banner on every restart trains the operator to scroll past the one that matters.
- **Only a password we just generated is ever printed.** Echoing `LAWHA_ADMIN_PASSWORD` back would copy a secret out of the environment into a log file, a systemd journal and `docker compose logs`. A hash is never printed either: useless to a human, useful to an attacker.
- **A refused password does not leave the server without an admin.** Under eight characters is rejected loudly on the boot log and a generated password is seeded instead. Failing closed here means nobody can ever sign in.

The alphabet drops `l`, `1`, `I`, `0` and `O`, because this password's whole life is being read off a terminal and typed into a browser, quite possibly over the phone. `LAWHA_ADMIN_PASSWORD` is read at the moment the first account is created and never again — a value in an environment file that silently reset someone's credentials on every restart would be a back door, not a setting.

**One config file.** `lawha.env.example` is committed and holds every setting the server reads, grouped, each with what it does and — more useful — what breaks if it is wrong. `docker-compose.yml` loads `./lawha.env` with `required: false`, so a missing copy is not a hard compose error.

The trap here was precedence, and it is the sort that wastes an hour: **compose gives `environment:` priority over `env_file`**, so anything left in the compose file's `environment:` block simply cannot be overridden from `lawha.env`. That block is now three values and they are the three that belong to the stack rather than to the operator — `LAWHA_DB_PATH` and `LAWHA_FILES_DIR`, because an env file that moved them would put the database on the container's ephemeral filesystem and the first `docker compose down` would take every board with it, and `LAWHA_SECURE_COOKIES`, because it and the TLS block in `docker/nginx.conf` are one change wearing two hats. Everything else was deliberately removed so `lawha.env` actually wins. `lawha.env` is gitignored; the example says so and the root `.gitignore` carries it.

`GET /api/admin/config` reports what the server is actually doing — auth, registration, cookie mode, master password **as a boolean**, session TTL, paths, account counts — behind the same `requireAdmin` as the rest of that router. Nothing on it is a secret and nothing on it may become one: if the honest answer to a field would be "the value", the field does not belong there. It went unrendered for a phase (known issue 19, now closed); `LawhaServerConfigCard.tsx` shows all nine fields on `/admin`, and types the master-password field `boolean` on the client so a hash could not compile into the shape even if the server started sending one.

**Folders, and selection instead of "export all".** Migration 005 adds `folders` and `board_folders`, whose primary key is `(board_id, owner_id)` — filing is **per person**, for the same reason tags are: a shared vocabulary means one person renaming a folder silently relabels everyone else's dashboard. Deleting a folder unfiles its boards and never deletes them, and the confirmation says so with the count in it: "Only the folder is deleted. Everything filed in it — N boards — becomes unfiled and stays in your dashboard." Duplicating a board does not copy its filing. The dashboard gained a folder rail, click and shift-click selection, "Select all N", and a bulk bar that exports, files or deletes the selection. "Export all" is gone: it was the wrong shape once a selection existed, and an export that silently omits the boards this device holds no key for is a backup with holes in it — the report names every skip.

**Identity on the wire.** The largest piece, and it has its own ADR (0006): the relay announces one `lawha-identities` row per socket in the room — name, palette index, avatar id, guest flag, `canEdit` — alongside `room-user-change` and never inside it. That closed three things at once: a peer's profile picture had nothing to fetch it _by_, `useLawhaPresence` deduped on a `collaborator.id` nothing ever set so one person with two tabs read as two strangers, and a link guest was indistinguishable from a signed-in viewer. Guests are individually named now (`Guest Heron`), because every one of them being "Guest" made two visitors indistinguishable from one person with two tabs. Pictures can be canvas cursors, pre-imaged through the dark-mode filter rather than corrected after it; opt-in per account, off by default, and the server withholds the avatar id from anyone who has not opted in — gated on the server, so the opt-in is a privacy contract rather than a rendering preference.

> **That last clause was not true as shipped.** Withholding the id from the payload does not make an opt-in a privacy contract while the endpoint holding the bytes will serve them to anyone who asks — and this same event is what hands every peer the id to ask with. `GET /api/users/:id/avatar` checks the flag itself as of §4.12. The sentence above stands only because of that fix.

**Two smaller moves.** The laser colour picker left the Lawha top bar and portals into the editor's own toolbar island, visible only while the laser tool is active — it is a property of a tool, so it belongs beside the tool. And the share panel became five headed sections with every link setting spelled out as a full row **for owners as well as viewers**; the old copy paraphrased the settings for non-owners and said "listed below", which a reorder had already falsified.

### 4.10 What integration found, that nobody had asked about

Three things were wired, tested, and not working. All three are the same shape: a failure with no way to report itself.

- **`createSocketServer` was never given its `identity` dependency.** The event fired with socket id, user id, guest flag and `canEdit` — and no username, no colour, no avatar, because those are the only fields that need the database. Nothing throws when the optional dep is absent, and no relay-level test notices. One line in `src/index.ts` was the whole difference between the feature working and looking wired.
- **`COLLABORATOR_PALETTE_SIZE` on the server was still `5`.** The palette has had twelve entries since ADR 0003. The new toolbar picker paints all twelve and seven of them answered 400. It survived a whole phase because the only test claiming to pin the bound lives on the client, where the server's constant is invisible, and the server's own "rejects a colour outside the palette" test used the literal `9` — which stopped meaning "outside the palette" the moment the wheel grew. **A stale test and a stale bound agreed with each other.**
- **The client's `LawhaUser` DTO never grew `avatarOnCursor`**, so the account panel reached the field through two type casts. It worked; it was also one rename away from silently reading `undefined`.

Two more that were nobody's feature: `yarn test:other` failed on any machine that had run `yarn test:visual`, because `yarn prettier` reads `.eslintignore` rather than `.gitignore` and the Playwright artefact directories were in neither; and `lawha.env.example` told the operator to add `lawha.env` to `.gitignore` themselves, which is not a thing to leave to a person when the file holds a master password.

**One loose end, recorded rather than tidied away.** The app suite collected 2244 tests before this batch and 2245 after, stable across repeated runs, and the extra one could not be attributed to any specific edit — the four app test files that changed match the per-file counts their authors reported. It is one collected test, not a failure, and it is written down here because "probably fine" is how a real discrepancy gets absorbed.

### 4.11 The lesson, stated once

**A duplicated constant is pinned where it is enforced, not where it is copied from.** Every one of the three integration findings above is a variant of it: a test that mocks the other side of the wire cannot pin the wire; a bound asserted on the client cannot pin the server; an optional constructor dependency that changes only the _content_ of a message cannot be pinned by a test that asserts the message arrived. If two copies of a fact exist, the test belongs next to the copy that decides the outcome.

### 4.12 The adversarial pass — five defects, and three of them were one defect

Phase 5's work was then read against its own claims rather than against its tests: for every sentence that promised something, where is the line that refuses? Five defects were confirmed and all five are fixed. Three are worth the space; two are short and recorded only so nobody re-derives them.

**`GET /api/users/:id/avatar` was ungated (medium).** Four places in the tree said the server "only sends `avatarId` for accounts that opted in" — `protocol.ts`, ADR 0006 §1, `identity.test.ts`, and the comment on the account panel's cursor toggle. All four were true and none of them was the door. The endpoint rested on its address being unguessable, which was a fair argument right up until `lawha-identities` began handing every co-present peer's account id to every other peer, link guests included; after that, withholding the id from the payload bought nothing, because the bytes were one hand-written `fetch` away keyed on an id the same payload had just supplied. The route now checks `avatar_on_cursor` for every caller but the owner and answers `404`, not `403` — whether an account has a picture it has chosen not to share is not the asker's business, so the refusal must look identical to having no picture. Pinned by seven tests in `avatar.test.ts`, including "makes a withheld picture indistinguishable from no picture at all" and "stops serving the moment the owner opts back out". **This is invariant 21 exactly** — a permission enforced in one layer is not enforced — and it is now written into ADR 0006's Consequences in those words, because the ADR had already written the sentence that gave it away — "that endpoint was already reachable by them", in its own Consequences, a page below the §1 promise it falsified. Two sections of one document disagreed and nobody read them together.

**A pointer payload could rename the peer that sent it (medium).** `lawha-identities` was correct on the wire and undone in the collaborator map. `updateCollaborator` merges with `Object.assign`; pointer and idle payloads carry their own `username` and `colorIndex`; a pointer arrives about every 33ms, so in steady state the sender's own claim was always the later write. A link guest has no session, so the effect that seeds the collab username from the account never runs and the client falls back to `getRandomUsername()` — the server had named them `Guest Otter`, and every peer watched that flip on the guest's first mouse move, while the guest's own presence stack went on showing the server's name because a sender never receives its own volatile broadcast. `getRandomUsername` also sits behind a dynamic `import()`, so a pointer sent inside that window carried `username: ""` and blanked the name outright. The security reading is the one that matters: a modified client could broadcast any name it liked, which is precisely what announcing identity from the server was meant to prevent. `Collab` now keeps `serverIdentities` and applies `pinnedIdentity()` last in the merge; a socket the server has not announced yet pins nothing, so "not yet known" still falls back to the payload and only "claimed" is refused. Pinned by `lawhaIdentityPinning.test.tsx`.

**`FoldersRepository.listForUser` counted boards the filer could no longer open (low).** `board_folders` cascades on board, on user and on folder — but not on membership. Revoking somebody's membership therefore left the filing row standing, and their folder chip read "Active · 1" over an empty grid, permanently, because the board was gone from their dashboard and they had nothing left to unfile. `boardCount` now mirrors the board access predicate in `BoardsRepository.listForUser`, so the chip and the grid beneath it cannot disagree. Pinned by four tests under "folders — boardCount counts only boards you can still open", including that the filing row survives so the count comes back if access does.

**A missing React key on the folder rail's rename editor (low).** One of `editor()`'s two call sites is inside a `.map`, and `react/jsx-key` only inspects JSX literals — it cannot see through a function call to the element it returns. A development-console warning that no lint rule and no assertion was ever going to catch; the helper takes a `key` argument now.

**The dashboard selection bar was locked on the wrong flag (low).** `busy` was `transferring !== null`, and `transferring` only ever meant import or export, so bulk delete and bulk move ran with their own buttons live — a second click started a second pass over a selection the first was halfway through deleting. There is a separate `isBulkRunning` now, set by a `runBulk` wrapper at the call site so that "create a folder and move into it" is one action holding one lock rather than two nested ones.

Neither of the last two carries a test. The missing key has no runtime effect, and the selection-bar lock is a prop threaded into a component whose disabled states `LawhaHomeSelection.test.tsx` is already the right home for — cheap to add, not added.

**What three of the five had in common.** The avatar endpoint, the identity merge and the folder count are the same defect wearing different clothes: **a rule was stated in one layer and enforced in another, or nowhere.** The relay declined to send an avatar id; the HTTP route did not decline to serve the bytes. The server announced a name; the client did not decline to overwrite it. The board list applied an access predicate; the folder count applied a different one. In each case every individual assertion was true and the composition was false — which is why the review that found them read the claims against the enforcement points rather than running the suite, and why all three now have a test sitting next to the line that refuses.

### 4.13 The batch that followed a real data loss — backup, restore, and the documentation that caused it

The database was destroyed. Not by a bug: by step 2 of the restore procedure in this repository's own `README.md`, which read `docker volume rm excalidraw_lawha-data`. Somebody followed the instructions and the accounts, boards and scenes went with them. Everything below exists because of that.

**A named volume was the wrong container for the one thing that cannot be regenerated.** `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune --volumes` and `docker compose rm -v` all destroy one, and so — silently and without any command at all — does running compose from a renamed or re-cloned checkout, because a volume's name is prefixed with the compose project name, which defaults to the directory name. The database is now a bind mount at `~/lawha-data`, which survives every one of those. The host user and the container's `node` are both uid 1000, so the ownership objection that put it in a volume originally does not apply here: `mkdir -p ~/lawha-data` is the whole setup.

**The WAL hazard, which is the part that turns a bad backup into an invisible one.** This database runs in WAL mode and spends its life as a 4KB header plus a multi-megabyte `lawha.db-wal`. `cp lawha.db` yields a database with **zero tables** — measured on this deployment, not theorised. It restores in silence, the server finds no accounts, seeds a fresh administrator and prints the first-boot banner. `tar` over the directory has the mirror-image failure: it can catch the `-wal` mid-transaction and archive a `-wal` that disagrees with its `.db`. Both of those were in the README as the supported procedure.

`lawha-server/scripts/backup.mjs` uses SQLite's **online backup API** instead, which answers all of it at once: safe against a database the server is actively writing, so no `stop` and no downtime, and it emits one checkpointed file with no sidecar anyone has to remember. The runtime image is `node:22-slim` and ships no `sqlite3` CLI, so `.backup` from a shell was never available either. The result is reopened, `PRAGMA integrity_check`ed and counted — a backup nobody verified is not a backup — and a file that fails is renamed `.rejected` rather than left in the directory looking like a restore candidate. Non-zero exit on any failure, so a cron wrapper notices. Retention (`--keep N`) is off by default.

`restore.mjs` inverts the order the old procedure got wrong. That one deleted the live data **before** anything had been proven about the archive replacing it. This one verifies the backup first and refuses before anything moves; then checkpoints the live database so `lawha.db` holds every page **before** it is renamed — without that step the move-aside would strand the tables in a `-wal` with no database beside it, the same hazard wearing a different hat — then moves it to `lawha.db.pre-restore-<stamp>` and copies the backup in. Nothing is deleted: only a `-wal` the checkpoint emptied, and the `-shm`, which SQLite rebuilds. A `-wal` that still holds pages is renamed alongside its database instead. It refuses outright while the server is running, because installing a file under a live process leaves it writing to a database that is no longer there.

**Nineteen tests, in `lawha-server/scripts/*.test.mjs`, run by `yarn --cwd lawha-server test` alongside vitest.** They are `node:test` rather than vitest, and they live beside the scripts rather than under `tests/`, because the scripts are plain `.mjs` with no build step and the test should spawn the artefact an operator actually invokes. That choice has one cost, paid at integration: the root vitest config's default include glob matches `*.test.mjs`, so `yarn test:app` collected these two files, found no vitest suite in them and reported two red suites for tests that are green in the runner that owns them. `vitest.config.mts` now excludes `lawha-server/scripts/**` for the same reason it already excluded `e2e/**`. The first one is the experiment rather than a claim: one live database with an unchecked `-wal`, copied two ways, asserting that the `cp` comes back with zero tables and the backup comes back with every row. That is the bug, pinned where it happened.

Verified against the live database with the docker stack up and healthy: `5 users, 4 boards, 4 board_scenes, 2 files`, `integrity_check ok`, one 262144-byte file with no sidecars, and `lawha.db-wal` untouched at the same size and mtime afterwards. Restore was then rehearsed on a copy of that real database — two extra accounts inserted and the process killed without closing, so they existed only in the `-wal` — and the pre-restore file came back with **seven** accounts while the restored file came back with five. That is the checkpoint-before-move step doing the only job it has.

**The rehearsal found a defect the suite would not have.** Piping the output into `head` closed stdout mid-run, node raised `EPIPE` on the next write, and the unhandled event killed the process with a non-zero status — reporting failure for a restore that had already completed, which invites somebody to run the whole thing again against a database that has already been replaced. Exit status is the entire interface these scripts have with a cron or systemd wrapper, so an EPIPE is now swallowed and every other write error is still re-thrown. Two tests pin it, running the scripts under `bash -o pipefail | head` so the pipeline reports the script's status rather than `head`'s. Worth recording as a shape: **the failure was in the reporting channel, not in the work**, which is the same family as §4.7's "silence is the bug" — a subsystem that cannot say what happened, saying the wrong thing instead.

**What the scripts do not cover, said out loud rather than discovered at restore time:** the uploaded blobs under `LAWHA_FILES_DIR`. The database holds file records; the bytes are on disk. They are immutable and already client-side encrypted, so `cp -a` is correct for them — the WAL hazard is specific to SQLite — and the backup script prints that reminder on every run.

**The README was rewritten around all of this**, including an explicit "never run these" table, because the belief that `docker compose build` is what destroys the data is both widespread here and false: rebuilding is safe, migrations are idempotent, and the commands that actually destroy data are the five `docker volume`-shaped ones. It also gained a "Making someone an administrator" section listing every mechanism that exists — first registration when there are no admins at all (not merely no accounts: `countAdmins() === 0` in `POST /register`), `LAWHA_ADMIN_USERNAME`/`LAWHA_ADMIN_PASSWORD` before first boot, `LAWHA_ADMIN_USERNAME` promoting an existing account on every boot, `/admin` for everyone after that with the last administrator undemotable, and the two locked-out routes. Every command in it was run against the live stack before it was written down, which is how the `docker compose exec lawha-server node dist/cli/reset-password.js` form was confirmed rather than recalled.

### 4.14 Six parallel batches, and the four defects that were each one line

Six areas were worked at once and integrated in one pass. What follows is the part worth keeping: in four of the six, the defect was a single expression that had been read past many times because it looked like the thing it was not doing.

**`proxy_set_header Host $host`.** nginx's `$host` strips the port; `$http_host` is the header as sent. The CSRF check compares `new URL(origin).host` against the raw `Host`, so from `https://192.168.1.50:9002` the origin carries `:9002` and the forwarded host did not. Every non-GET 403s and every GET succeeds: boards open, nothing can be saved, renamed, shared or deleted. That reads as a broken product, not as a missing four characters, and the websocket handshake fails separately through socket.io's CORS allowlist — one typo presenting as two unrelated bugs. Pinned from both sides: `csrfOrigin.test.ts` proves the stripped-port case 403s and the `$http_host` case passes, and `deploymentConfig.test.ts` asserts nginx has exactly two `Host` proxy headers and both are `$http_host`. The test helper had to be written against `node:http`, because `fetch` cannot set a chosen `Host` and the existing `testApp.request` overwrites `Origin` — which is precisely how this survived a suite that already had CSRF tests.

**`app.set("trust proxy", true)`.** `true` trusts the whole `X-Forwarded-For` chain and Express then reads the **left-most** entry as `req.ip` — the entry the client wrote. Every per-IP limit was therefore a bucket the caller chose, fresh on each request: decorative, not enforced. It is now a count, `LAWHA_TRUST_PROXY_HOPS`, default 1, because nginx _appends_ (`$proxy_add_x_forwarded_for`), so the last entry is an address nginx observed. There is no safe "just use `true`", and no safe universal number either: too low and a whole LAN shares one bucket, too high and you are back to trusting a client-written entry.

**`if (this.portal.socket) return null`** in `Collab.startCollaboration`. Wrong twice over: shaped like the _socket_ rather than the _room_, and not synchronous with what it guards — `portal.socket` is not assigned until several awaits later, so two calls in one tick both passed. Together with a `collabAPIAtom` that was never cleared on unmount, this is why a board with content opened blank: the previous board's Collab stayed in the atom, `App.initializeScene` ran against it, the dead instance opened a socket nothing would ever close, the relay stopped treating the real client as first-in-room, and the zombie answered with a `SCENE_INIT` carrying the empty scene of a torn-down editor. Eighteen bytes of `[]` beat a live peer's tens of kilobytes every time. The fix has four independent parts — an unmount flag checked after every await, clearing the atom _by identity_, a room-shaped claim taken before the first await, and loading the board's own copy from the server unconditionally rather than only on `first-in-room` — and `collabBoardReopen.test.tsx` is the first test in this repository that mounts two boards in one page session, which is the only shape any of it is visible in.

**`socket.off("connect_error", this.fallbackInitializationHandler)`.** `off` matches by identity and the registered listener was an anonymous arrow that _calls_ that fallback. Three call sites removed nothing, so a fetch-and-discard stayed armed for the session on a room the user may already have left.

The other two areas found holes rather than typos. `POST /api/files/...` checked "can you access this board" and never `canEdit`, so a viewer refused the scene write could still write 4 MiB blobs into that board's file directory — invariant 21's fourth site, added there. And `GET /api/files/...` refused the guest principal that share links mint, so a link visitor loaded a board whose images were all holes; invisible in testing because you never fetch your own images and signed-in peers were fine.

**The master password became visible.** It was an invisible fallback — you typed it into the password field and it happened to work — which is a credential with permanent consequences being used by accident. There is now an explicit checkbox, rendered only where `GET /api/auth/config` reports one exists, and ticking it _skips_ the account's own password so the flag is deliberate rather than incidental. It also gained the only limiter that can key on it: a **global** budget of ten verifications per fifteen minutes. The existing two cannot cover this credential — `FailureBackoff` and the login limiter are keyed on the username, and the master password has none, so an attacker rotating usernames spreads guesses across as many buckets as there are accounts and fills none of them; the per-IP limit is deliberately loose because an office sits behind one NAT address. Two known weaknesses are recorded in the code rather than papered over: the budget is spent by ordinary mistyped passwords too, and it lives in memory, so a restart clears it. A spent budget closes only the skeleton key — everyone still signs in with their own password.

**The admin router had no rate limit at all**, and adding one behind `requireAdmin` would have left the half that matters uncovered, since an unauthenticated caller who guesses the path can hammer it for as long as they like. It sits in front, which is only safe because `callerOf` buckets a signed-in caller by account id and everyone else by address — filling the anonymous bucket cannot lock the administrator out of the recovery panel. And the one operation that leaves a _permanent_ mark, granting `is_admin`, now writes a line to stdout naming the actor and whether it was `(via master password)`. Setting a password had always left a trace; the durable change had not.

**`/admin` signs you in where you stand.** A signed-out visitor gets a sign-in rendered in place instead of a redirect to `/signin` and back. At the time the screen had to be _indistinguishable_ from `/signin` — same component, same heading, same copy — because `/admin` was unlisted and a login screen asking for administrator credentials would confirm the address exists; the test pinned that by rendering both screens and asserting the card's `textContent` was **equal**. **ADR 0009 later gave that up**: `/admin` now renders `LawhaAdminGate`, which names the page, tells a signed-in non-administrator that their account is not enough, and offers the master password as an explicit segment rather than a checkbox. The redirect that used to bounce a signed-in non-administrator to `/` is gone with it — it was reported as a bug, which is the failure mode of a control nobody can tell apart from a fault. The equality test was deleted rather than weakened; the reason is written into `LawhaAdminRoute.test.tsx`. None of it makes the master password a page unlock: it still needs a username.

**Two things worth knowing about verifying this batch.** The empty-board fix was checked by putting `HEAD`'s `Collab.tsx` and `data/storage/lawha.ts` back and running the new suite against them: four of ten tests fail, including both halves of the reopen bug. Three of the remaining six are guards against the _fix_ rather than against the old code — "writes nothing over an empty result", "does not clear a board whose stored scene is empty", "stops loading promptly when a peer is present" — and they pass either way by design, which is fine as long as nobody mistakes them for regression coverage. One that does not pass either way is worth naming: "does not take a peer's empty `SCENE_INIT` for the board's scene" passed against the unfixed code in the integration run, because on the _first_ board of a session `App.initializeScene` loads storage on its own and the defect only bites from the second board onwards. It is a good forward-looking assertion and a poor witness; §5's entry 24 records it.

### 4.15 The Library dashboard, and the second Share nobody had counted

The dashboard was rebuilt from a design drawn against this repository's own `--lw-*` tokens: a nested folder tree with a breadcrumb and subfolder tiles, Tiles and Details views, drag-to-file, and Import/Export/Tags as modals. ADR 0007 carries the decisions; this section keeps only what was learned doing it.

**The unique index was the whole feature.** Migration 005 had `UNIQUE (owner_id, name)` and nesting needs "unique among siblings". The obvious `UNIQUE (owner_id, parent_id, name)` is silently wrong — SQLite treats NULLs as **distinct** in a unique index, so two root folders called "Clients" would both have `parent_id NULL` and would not collide, quietly undoing the very constraint the migration was meant to preserve. Two partial indexes split on the NULL-ness of `parent_id` instead. Pinned twice, at the schema (`migration006.test.ts`) and at the route (`folders.test.ts`), because it is the kind of thing that only shows up as "why do I have two identical folders" weeks later.

**Three bugs surfaced, and all three were silent by construction.** `folderColor` asserted non-null on a palette lookup, so an index the build did not recognise blanked the whole dashboard behind the error boundary — and reported itself as an unrelated jotai error thrown by the `<Trans>` the boundary rendered. `useBoardDrag` assigned `dataTransfer.effectAllowed` outside the try/catch that already wrapped `setData`; both are cursor hints, and an exception from either aborts `dragstart` before the drag begins. And `migration005.test.ts` asserted "1 migration ran" against the **live** migrations directory, so 006 turned a meaningful assertion into arithmetic about how many files exist — the staging helper it needed was already three lines above it.

**A drop target that omits `preventDefault` in its own `dragover` is not a drop target.** `drop` never fires, nothing logs, and the cursor says no without saying why. `LawhaHomeFolders.test.tsx` therefore asserts the prevention itself via `fireEvent`'s return value, not only the resulting PATCH — no outcome-shaped test can tell "not a target" apart from "a handler that ran and declined". Verified by neutralising that one line: three of eight tests fail.

**Shape counts are the server's blind spot, said out loud.** The server holds ciphertext and cannot count anything, so the number on a card comes from the decrypt the preview already did, cached per board _revision_ so drawing on a board and coming back re-decrypts. A board with no key on this device is **unknown, not empty**: it says so, and "Most shapes" sorts it last rather than as zero.

**There were two ways to share, and the second one was a hole.** The main menu's "Live collaboration", the welcome screen's copy of it and two command-palette entries all opened upstream's `ShareDialog`, which calls `startCollaboration(null)` and hands out a link with **no owner check at all** — while Lawha's own panel gates link access on `isOwner` and the server refuses a non-owner's change outright. Invariant 21 in its usual shape. The everyday failure was worse than the security one: that dialog's "Stop session" leaves the room and does _not_ turn sharing off, so pressing it felt like un-sharing a board anyone with the link could still open. All four entry points are gone.

**A rename reached exactly one screen.** `AppState.name` is browser-local and the rename was a REST PATCH with nothing behind it, so every other person in the room kept the old title indefinitely with nothing saying otherwise. There is now a server-authored `lawha-board` event, for ADR 0006's reason: it is a fact about the board rather than about the sender.

### 4.16 Four silent sync defects, a drag that did not exist on a tablet, and a laser frozen at first sight

Seven complaints, from using the product rather than reading it. Three were removals. ADR 0008 carries the decisions; what follows is what was learned.

**The drag worked, and did not exist.** `dragstart` never fires from a touch, so the whole drag-to-file feature was absent on a tablet — not degraded, absent, with nothing on screen admitting it. The browser also refuses to scroll during a native drag, so a folder below the fold was unreachable: you could pick a board up and have nowhere to put it. §4.15 chose the native API for forty lines of savings; those forty lines cost the feature on half the ways into this product. It is pointer events now, one implementation for boards and folders where the sidebar previously ran a second hand-rolled one of its own.

**And the first attempt at the rewrite had a bug the test caught.** `targetProps` carried a boolean the caller computed from the live drag — but the first `pointermove` both _begins_ the drag and hit-tests, so React had not re-rendered and every target still carried the value it held while nothing was dragging. A flick that picked up and dropped in one movement landed nowhere. What a surface accepts is static and lives in an attribute; whether _this_ drag may land there goes through a callback invoked with live values.

**jsdom implements no `PointerEvent`, and drops every property silently.** `fireEvent.pointerDown(node, { button: 0, clientX: 3 })` falls back to a plain `Event`, so the handler reads `undefined` for all of it — and `button !== 0` is true for `undefined`, so it returns before it starts. The failure looks _exactly_ like a product bug: no error, no warning, a gesture that simply does nothing. Polyfilled over `MouseEvent` in `setupTests.ts`. This is the same lesson as the fonts file (invariant 7): a test environment that quietly does less than the browser produces confident, wrong conclusions.

**Four sync defects, all silent, all in the reconnect window.** `broadcastScene` wrote `broadcastedElementVersions` — the map that means "peers already have this" — _before_ awaiting a send that is a no-op while the portal is closed, so work drawn during a reconnect was marked delivered and skipped by every later delta. A peer's `SCENE_INIT` answering our own rejoin arrived after `handleReconnect` re-armed the flag and fell out of the handler with no fallback. `queueSaveToBackend` skipped while uninitialised and lodash's throttle does not retry, so the trailing call was spent — and invariant 17 means the server copy is the only durable one. And the dashboard's `reload()` ran once in a mount effect, so the board list was a snapshot of the moment the page opened.

**Neutrality-checking caught an assertion worth nothing.** One reconnect test counted socket emits, and passed against the bug too: with the element wrongly recorded as delivered the broadcast still fires, it just carries an empty `elements` array. It decrypts the payload now. Every fix in this batch was checked the same way — break it, watch the matching test fail — and this is the one that would otherwise have shipped as coverage.

**The laser was frozen at first sight, and had been since ADR 0002.** `laserTrails.ts` builds one trail per peer and closed over the collaborator object from the moment it was built; `updateCollaborator` replaces that object on every update. Since a pointer event precedes `lawha-identities`, the trail was almost always created _before_ the colour was known — so the peer's cursor showed the colour they chose and their laser showed a hash of their socket id, all session, and only the wrong one moved. The same line called `getClientColor` with no theme, the only such call site in the tree, which on a dark-mode canvas is not a shade out but the other colour. ADR 0002 named that file and set that rule; nothing pinned either.

**One planned fix turned out not to be a defect.** `first-in-room` de-registers itself, so a solo reconnect never re-runs it — but `handleReconnect` is driven by `room-user-change`, which the relay emits unconditionally at join. Reported as found rather than "fixed", which is the second time in two sessions that reading before writing saved a day of producing a second copy of something that works.

**Two of the four things asked for already existed**, and finding that out was most of the work on them. Stopping a share already reaches everyone — `applyBoardAccessChange` re-resolves every socket, evicts, demotes, and the client flushes the work on screen to local storage before tearing down, all pinned by `share.test.ts`. And the main-menu trigger is already lifted into the top bar by CSS, with the welcome-screen hint re-anchored from the same custom property. Building either again would have been a day spent producing a second implementation of a working feature.

**`yarn --cwd lawha-server migrate` had never worked.** The CLI sat at the bottom of `db/migrate.ts` and reached `openDatabase` through a top-level `await import("./index.js")`, while `db/index.ts` imports `runMigrations` from `db/migrate.ts` — a module cycle with a top-level await across it. Node exits 13 with "Detected unsettled top-level await" and applies nothing. Nobody noticed because migrations also run on boot, so the only person it could ever fail is someone deliberately applying them by hand. Found by doing exactly that, against a copy, which is the one drill this project insists on before a migration touches real data.

### 4.17 The escrow's second half — seven doors, and the crypto was never the hard part

> **Read the eighth defect at the end of this section first if you are here about padlocks.** Seven of the eight below are doors that were never opened; the eighth is why the screen kept drawing a lock over a board whose key was already in the browser, and it is the one a user reported.

ADR 0010 shipped the escrow: the wrapping, the routes, the recovery code, and fifteen tests over `keyEscrow.ts`. What it did not ship was every way in. `41fa2c0d` recorded the symptom honestly rather than pretending otherwise — a board whose key was escrowed, unwrapped and written into this browser's key store still drew a locked card — and named the dashboard's `openable` refresh as the suspect. It was not the dashboard. Every defect below is a **door**: a call site, a form field, a fallback branch. The escrow's own tests could not see any of them, because they test the escrow rather than the ways into it.

**The upload guard counted rows it could not open.** `syncEscrowedKeys` downloads, then uploads whatever the account holds locally and the server does not — and it built that "already held" set from **every row the server returned**, not from the rows that actually unwrapped. `board_keys` has no foreign key to `account_keys`, so a row wrapped under a master this account no longer has outlives the master that wrapped it: undecryptable, and counted as held. The good local key was therefore never uploaded, the board read as locked on every other browser indefinitely, and there was a row on the server that looked like a backup and was not one. `held` is built from the unwrap result now. Two attempts at the dashboard's refresh failed before this was found, and both deserved to: the dashboard was right. There was no key to be had.

**There was nowhere to type the password.** The master key lives in the tab's memory and nowhere else, deliberately — a `sessionStorage` copy would mean a stolen unlocked laptop yields every board without the password. It was derived in exactly one place, the sign-in form. So a session restored from the cookie could never reach the escrow at all: no password typed, no master key, `syncEscrowedKeys` returning 0 every time. **That is what the wip commit's "zero escrow console output" was telling us** — not an effect that failed to run, an effect that ran and had nothing to do. `LawhaEscrowUnlock` is the missing door, rendered first on the locked-board screen with the share-link field demoted to the fallback it now is. It has a recovery-code segment beside it, because a wrong password and an escrow the password genuinely cannot open any more (an administrator reset it out from under the account) are indistinguishable from the client — both are just "the wrapping did not open" — and telling somebody their correct password is wrong is how people retype a working credential until they give up.

**`resolveBoardKey` stopped one step short.** Link → this device → locked, with the escrow never consulted, so opening a board from the dashboard on any browser but the one that made it hit the locked screen with the key sitting wrapped on the server throughout. It is link → device → escrow now, and `/b/<id>` is not behind `RequireSession`, so the signed-out link visitor still gets the same shape of answer.

**`rewrapForNewPassword` shipped with tests and no call site.** The wrapping key is derived from the account password, so a password change that does not re-wrap the master strands the whole escrow — and every self-service password change since ADR 0010 did exactly that, silently, surfacing later and elsewhere as "no key in this browser". This is §4.11 again in a new costume: **a tested function is not a called one**, exactly as `canEdit` was enforced nowhere for months (invariant 21). `changeAccountPassword` now unlocks first (the current password is sitting in the form, which is precisely what a cookie-restored session lacked), changes second, re-wraps third, and throws `EscrowStrandedError` if the last step fails — its own type, because the password _did_ change and "could not change your password" would send the user to retry against a credential the server no longer accepts.

**`/admin` was a second sign-in that skipped the unlock.** It goes through the bare `authApi` request on purpose, and `openEscrow` was module-private, so an administrator who signed in there and then opened their boards found every one of them locked. Exported and called — but not on the master-password path, which is not an account credential and derives nothing.

**Duplicate manufactured a board nobody could ever open.** It copied first and remembered the key `if (key)`, so duplicating a board this browser could not read succeeded, said nothing, and left a second permanently unreadable board on the dashboard. The account this was found on had one sitting beside its original. The key is resolved **before** the copy now and a miss aborts with a message naming the board.

**Two views disagreed about what a board is.** `lw-board-row--locked` was applied in Details and defined in no stylesheet, so the state Tiles announced with a padlock read there as a disabled button — a rendering accident rather than a fact. And the padlock note in Tiles was the last child of the `<button disabled>`, which is the one place in a card that a keyboard cannot reach and a pointer cannot hover: the only statement of why the card was dead was available exclusively to someone looking at it with working eyes. It sits beside the button now, with a focusable "unlock" link into the board's own screen. Export was the same omission in a third place — `buildBoardBundle` listed every escrowed board as a skip, and syncs once up front instead.

**And the eighth, which was the one the user actually reported: the dashboard read the key store before the escrow had opened, every time.** Everything above was true and the padlocks stayed. `signIn` publishes the session with `adopt(user)` and only _then_ awaits `openEscrow(password)` — while `RedirectIfSignedIn` is watching that same atom, so it navigates to `/` the instant the first line lands. The dashboard therefore mounts _during_ a 600k-iteration PBKDF2, reads an empty key store, and marks every escrowed board locked. The keys arrive a beat later and nothing re-reads them. It is not a flake: the ordering is fixed by the code, so it is lost every single time, which is exactly what "still locked, deterministically, twice" in `41fa2c0d` was recording.

Both earlier attempts were about _how_ the grid refreshed — reload unconditionally, then set the key set directly — and neither could have worked, because the refresh was not wrong, it was **early**. `escrowAtom` had been publishing the moment that mattered since ADR 0010 and nothing was listening. The mount-time effect is now keyed on `escrow.state`, so the grid re-reads on every transition into `open` and on no other: `needs-recovery` and `unavailable` mean no key was recovered, and re-reading on those would be a guess wearing a refresh's clothes.

**How it was finally caught, because the method is the transferable part.** Every previous attempt reasoned about the dashboard from the dashboard. What found it was measuring two browsers against the deployed stack and printing the key store beside the rendered card:

```
B keystore after signin:      ["a0d371…"]     <- the key IS here
B locked cards (no reload):   1 of 1          <- and the card says it is not
B locked cards (after reload): 0 of 1         <- a reload fixes it
```

Three lines, and they eliminate the entire crypto layer: a defect that a page reload cures is a defect in what the screen re-reads, never in what the server stored. `e2e/escrow.spec.ts` is that measurement kept, and it is the first test in this repository that drives two browser contexts against a real server — the shape the bug needed, since one browser can never be a browser that has never held the key. Its first draft failed against a build that was already fixed, which is worth as much as the bug: it navigated to `/home` immediately after signing in, and that full page load tore the tab down mid-`openEscrow` so the keys never landed at all. **A test that hurries past an await is testing its own impatience.**

**What all eight have in common** is the sentence this file keeps having to write: the mechanism was right and nothing used it. The escrow worked on the day it shipped; what it had was one door, and a feature reachable through one door is a feature that works for the person who happened to walk through it. Fifty-two tests across six files pin the doors rather than the crypto — `boardKeysEscrow.test.ts` on the sync and the resolution, `escrowPasswordChange.test.ts` on the three-step order and the stranded case, `LawhaEscrowUnlock.test.tsx` on both segments, `LawhaBoardCardLocked.test.tsx` on what each view says about a locked board, `LawhaHomeEscrowRace.test.tsx` on the grid catching up to an escrow that opened after it mounted — and the point of each is a call site, not an algorithm. Plus the two end-to-end, which are the only ones that could have found the eighth.

### 4.18 The ninth, which was a rule rather than a bug: the master is cached now

The eight above were all defects. This one was a **design rule working exactly as written and producing an unusable product**, and it was overturned by the person using it, in one sentence: _"no more locking canvases — each account can see his from anywhere."_

The rule was in `keyEscrow.ts`'s header and it was argued well: the master key lives in a module variable for the life of the tab and is never persisted, because "a stolen unlocked laptop yields every board without the password", and a reload costs one PBKDF2 run on a screen already waiting for the network. Every word of that is true and it misses the case that matters. A returning visit has **no password to run PBKDF2 on**. The cookie is still good, so nothing asks; the master is therefore unobtainable; the sync cannot unwrap; and the dashboard says "no key in this browser" about a key the server is holding, on the person's own account. The intermediate attempt — a prompt on the dashboard offering to unlock — was built, screenshotted, and rejected on sight, correctly: being asked for your password to look at your own boards is the failure wearing an apology.

So `restoreEscrow` now reads a cached master out of `lawha-escrow`, this origin's own IndexedDB, and the session loader calls it the moment a cookie resolves to a real account. Nothing is asked, and the dashboard's key set is already keyed on the escrow state, so the grid picks the keys up on its own.

**The cost, stated where it can be found rather than in a commit message.** This origin's IndexedDB previously held the board keys you had opened here; it now also holds the master, so disk access to a browser profile yields every board the account has escrowed rather than the subset that browser had seen. That is a real widening and it is smaller than it first reads — the session cookie sits in the same profile and already yields the account. It is scoped per origin like everything else in the key store, and `lockEscrow` deletes it on sign-out, which is the moment the "next person at this desk" argument is actually about. Not caching it never bought the security the header claimed: it bought a password prompt people would type into anyway.

**Two notes on testing it, both of which nearly produced a false green.** The end-to-end test for this restores a browser profile and asserts no padlocks — and restoring IndexedDB restores the board keys too, so that assertion passes with the escrow switched off entirely. It now creates a **second** board in a browser the first has never met: that key exists nowhere in the restored profile, so the only way it can appear is the cached master unwrapping it. And three existing suites went red on a mock rather than on the product — their `idb-keyval` fake ignored the store handle, so the master landed in the board-key map and `getOpenableBoardIds` reported a board called `master`. Separate databases in a browser, one map in the mock. **A fake that is simpler than the thing it replaces will eventually disagree with it about something that matters.**

### 4.19 The tenth: the padlocks that survived §4.18, and the race nobody had to lose

§4.18 closed with "each account can see his from anywhere" and it was not true yet. Six paths were still open, and what they have in common is that **each of them was a place where being able to open a board and being _drawn_ as able to open it had drifted apart**. None is a crypto defect. The escrow held every key it was asked to hold.

**The escrow write for a new board was racing the board row, and usually winning.** `onNewBoard` stored the key before `createBoard` — correctly, because a board row with no local key is unrecoverable — and `rememberBoardKey` fires its escrow write from inside that call, un-awaited. But `PUT /api/keys/boards/<id>` is authorised through `resolveBoardPermission`, which denies a board id the server has never heard of (`allowUnknownBoards` is false wherever auth is required). So the write was legal only if `POST /api/boards` arrived first — and nothing made it. It usually did, because `escrowBoardKey` runs two `crypto.subtle` operations before reaching its `fetch` while `createBoard` goes straight to the network. **A feature that works because of how long AES-GCM takes is not a feature that works.** When the race went the other way the 401 was swallowed three times over — by `request()`, by the discarded return, by `void` — and the board was escrowed only if that same browser later ran a sync. `boardTransfer` copied the ordering verbatim, comment and all, which is where it mattered most: an import plays the same race once per board with the network already loaded.

The fix is a split rather than a swap. `rememberBoardKey(id, key, { escrow: false })` keeps the local write first; `escrowBoardKeyNow` runs after the row exists and returns `"escrowed" | "no-escrow" | "refused"`. Three outcomes rather than a boolean, because two of them are ordinary and one is a defect, and collapsing them is precisely how the defect stayed invisible — a link visitor's locked escrow and a server refusal were the same `false`.

**Two writers shared one `openable` set, and the loser was whichever finished last.** `reload()` reads this browser's key store; the escrow effect reconciles with the account. Holding one set between them meant a local-only read landing after the escrow had delivered re-locked every card — and since `reload()` also runs on `focus` and `visibilitychange`, alt-tabbing back to the dashboard could do it, with no further transition into `open` to undo it. This is the §4.17 defect-8 lesson arriving a second time in a different costume: not _how_ the grid refreshes, _when_ — except that here the answer was not to sequence the writers but to stop them sharing. Two sets unioned at render cannot have the bug in either direction and need no ordering to be correct.

**"Openable" meant "in IndexedDB", which is narrower than the truth.** `getOpenableBoardIds` is a local read, so a board whose key had arrived but not yet been cached — or whose cache write failed — drew a padlock over a key that was in hand. `syncAndListOpenableBoardIds` returns the local store **union the escrow rows that actually unwrapped**, from the same reconcile, in one round trip instead of two. Unwrapped, never merely returned: counting an undecryptable row here would draw an openable card over a board that cannot be opened, which is defect 1 of §4.17 wearing the other hat.

**The dashboard had no door at all.** `LawhaEscrowUnlock` was mounted in exactly one place, the per-board locked screen. So `needs-recovery`, `unavailable`, and a cookie-restored session on an origin holding no cached master all ended in a grid of padlocks with nothing on the page to act on — the only route forward was to guess that a dead card led to a form. The intermediate design §4.18 rejected was an _unconditional_ prompt, and that rejection stands. `LawhaHomeEscrowNotice` appears only when the escrow is shut **and** a board on screen is locked, is collapsed until asked, and is dismissible. Nobody is asked for anything to look at boards that already work.

**The preview and the card disagreed about the same board.** `boardThumbnail` used `getBoardKey`, so an escrow-only board drew an empty plate beside a card that had stopped saying "no key here". `resolveBoardKey` now, which is the function that knows about all three sources.

**And the silence.** `request()` collapsed every non-2xx into `null` — no status, no path — so a 401 refusing a board key was indistinguishable from an account with no escrow. It logs now, with one deliberate exemption: 401 on `GET /keys` for a signed-out link visitor is an ordinary state, not an error.

**The one padlock that is not a defect, stated so it stops being reported as one.** A board _shared with you_ is escrowed under your master only once your browser has held its key. The server cannot fan it out, because it cannot unwrap anything. So a shared board must reach you by link once; everywhere after that is free. That is end-to-end encryption, not a bug, and it is now the only remaining route to a locked card on your own dashboard.

**A note on what the regression tests cost, because it is the transferable part.** The mock in `boardKeysEscrow.test.ts` accepted a board key for any board id, which no deployment does — so the ordering defect was invisible to the suite that owned it. It has a strict mode now, opt-in, used by the block where the refusal _is_ the subject. And the new dashboard test was checked against a deliberately broken build before being trusted: it reported 1 locked card where it should report 0, which is the same three-line measurement §4.17 was finally caught by. A regression test nobody has watched fail is a regression test with an unknown value — this repository has shipped one before (known issue 24).

**One unrelated test moved, and it is worth writing down rather than burying.** `LawhaAuth.test.tsx`'s avatar assertion used the default 1000ms `waitFor` and was landing at ~1030ms; adding a 178th file to the suite was enough to push it over. It failed on how busy the machine was, not on the product. The deadline moved to 5s and **the assertion did not change** — weakening what it checks would have hidden the real regression the next time one arrived.

### 4.20 One address, no port: `https://lawha.local` on a device of its own

The deployment stopped being a guest on somebody else's machine, and almost every oddity in the compose file turned out to be a consequence of that rather than a design.

**Three published ports became two, and both are standard.** `9002:443`, `${LAWHA_GATEWAY_PORT}:8080` and `127.0.0.1:${LAWHA_PORTLESS_PORT}:80` existed to feed two different proxies in front — a Link Hub that could not terminate TLS and needed a bounce, and a loopback `portless` that could and needed plain HTTP behind it. Neither is in the picture on a dedicated device, so both hops are deleted along with the `:8080` server block. ADR 0005 §3 chose 443 originally _because a non-standard port ends up inside every share link_; that reason never stopped being true, it just stopped being affordable while a gateway held the port.

**The guard that said "nothing binds host 80" is inverted, not removed.** That assertion was load-bearing when a gateway owned the port — taking it presented as "the gateway is down", on a machine nobody was looking at — and the reasoning is kept in the test that replaces it. The inversion also retires a subtler hazard: the old assertion was a **negative** one over a list somebody had to build, and it had already gone green against eight of the nine ways docker spells a host-80 binding. A positive assertion cannot fail that way. `composePortGuard.test.ts` survives anyway, because "the list-builder narrowed and nobody noticed" is a failure worth being unable to have.

**`:80` is published to the LAN now and must never serve the application.** It answers `/healthz`, serves `/lawha-ca.pem`, and 307s everything else. That is the whole security argument for publishing it: a browser left on a plain-http origin finds `window.crypto.subtle` undefined, and since that is on the decrypt path as well as key generation, Lawha is inert rather than degraded. `deploymentConfig.test.ts` pins that the block contains no `proxy_pass`, no `try_files` and no SPA index — a constraint, not a description, because the next person to add a `location` there will not be thinking about invariant 18.

**A CA, because the alternative is a warning that comes back.** `scripts/gen-certs.sh` replaces an `openssl req -x509` heredoc that was duplicated in two READMEs and produced a `CA:FALSE` self-signed leaf. That leaf had to be re-imported on every device each time it was reissued. A CA moves that to once per device, permanently. The cost is written down rather than glossed: whoever holds `lawha-ca-key.pem` can mint a certificate for any name those devices accept. The script also fills the SAN list from the machine's own addresses, because a SAN that omits the address someone types is not a warning they can click past — it is `ERR_CERT_COMMON_NAME_INVALID` and the page never loads.

**One file serves the CA, not one directory.** `location = /lawha-ca.pem` with an `alias`, never a `root` over `certs/` — that directory also holds `lawha-key.pem` and `lawha-ca-key.pem`, and a prefix match would publish the deployment's private keys over plain HTTP to the LAN. Verified rather than assumed: both key paths were requested on both schemes and neither returns key material.

**The port disappeared from the redirects too.** `LAWHA_HTTPS_PORT` became `LAWHA_HTTPS_SUFFIX` and is empty, so `http://<ip>/x` now bounces to `https://<ip>/x` rather than `https://<ip>:443/x`. Kept as a variable rather than deleted so republishing on a non-standard port is a one-line change instead of a rediscovery — and it matters more than tidiness, because the CSRF check compares `new URL(origin).host` against the raw `Host`, so a port that appears in one and not the other 403s every write while every read keeps working.

**What was checked, since a config change that only builds is not a config change that works.** `nginx -t` against the rendered template (both with and without a canonical origin); `http://` → `https://` on three different Host headers; the CA downloadable on both schemes and the private keys not; `https://lawha.local` returning 200 with `Verify return code: 0 (ok)` against the new CA; and a **POST** through both `lawha.local` and the bare IP answering 401 rather than 403, which is the one that proves the Host/Origin agreement survived. The escrow end-to-end suite then passed against the portless origin unchanged.

**Still not done, and it is a resolution problem rather than a code one.** `lawha.local` has to resolve to the new device. It is an mDNS name, so it works on the local link and not over a tailnet, and this network already had something else publishing it. `LAWHA_CANONICAL_ORIGIN` stays empty until that is settled — turning it on early is precisely the outage `c75178ba` recorded. `docs/deploy.md` is the procedure, including moving an existing deployment across.

### 4.21 The backup that could not rebuild the deployment

`lawha-backup` already worked: verified snapshots through SQLite's online backup API, an append-only blob mirror, a status file the healthcheck reads. Three things were wrong with the **policy** rather than the mechanism, and one of them was written down as a decision.

**The configuration was excluded on purpose, and the purpose was wrong.** `README.md` said of `lawha.env`, `./certs` and `./.env`: _"No. Copy those yourself; they are configuration and secrets, not data."_ Every word is true and the conclusion does not follow. Restore without them and you have every board, every account and every scene — behind a certificate no device on the network trusts, with an administrator password nobody knows. That is a backup of the data and not of the deployment. They are mirrored now, `0600` inside a `0700` directory, overwritten in place rather than kept in generations (the database is the thing worth history; fourteen generations of a master password is fourteen copies of a secret).

**The archive is secret-bearing as a result, and that is the trade.** It always held argon2 hashes and every board's ciphertext; a master password and a CA private key are a different category. Stated in the script header, in `lawha.env.example`, and in the README rather than left for someone to notice.

**It was all on one disk.** `~/lawha-backups` defaults to the same disk as `~/lawha-data`, so the failure that takes the database takes the archive with it — a filing system, not a backup policy. `LAWHA_BACKUP_MIRROR_DIR` copies the whole archive to a second mounted path after each verified run. **After**, not alongside: `backup.mjs` has already opened, integrity-checked and row-counted the artefact by then, and a corrupt file copied promptly is still corrupt.

**A mounted path rather than an rsync or ssh target, and the reason is worth keeping.** The runtime image has neither binary. Adding them would also mean putting a private key inside the container whose entire job is to hold your data. Mount the destination on the host — second disk, NAS, sshfs — where the host already keeps credentials, and hand in a path. A path that is set and not mounted is refused at start-up rather than failing every interval into a log nobody reads.

**The schedule was never chosen.** The live `lawha.env` predated `lawha.env.example` and had no `LAWHA_BACKUP_*` section at all, so the deployment ran entirely on the script's built-in defaults. 24h/keep-14 may well have been right; nobody had decided it. It is 6h/keep-28 now — a week of history, at most six hours ever at risk — written down where it can be argued with.

**Two docker footguns, both turned into messages.** A _missing_ bind source is created as an empty **directory**, and `lawha.env` and `./.env` are both gitignored and genuinely absent on a fresh clone — so `mirror_config` detects a directory where a file belongs and names the host file, instead of copying nothing and reporting success. And `docker compose restart` never re-reads any of this, because a container's environment and mounts are fixed when it is _created_.

**What is pinned, and where the risk actually is.** `backup.mjs` has thirteen tests of its own; what had no witness was the **wiring** — a script working perfectly that cannot see `./certs` produces a confident, useless archive. `backupCoverage.test.ts` asserts the mounts exist and are read-only, that `take_database_backup` contains no `cp`/`tar`/`rsync` (scoped to that function, since `cp` is correct for the immutable blob and config mirrors), and that `run_once` orders database → blobs → config → off-host. Each assertion was checked against a deliberately broken compose file before being trusted.

### 4.22 Three of the six: copy that lied, copy that filled, and a follow button with no way back

Items 7, 8 and 12 of the four-phase batch. Items 9, 10 and 11 are **not done** — see known issue 28.

**A field wearing two names (item 7).** The registration form labelled its input "Display name" while its `name` attribute, its autocomplete hint and the API field were all `username` — so the one name the user read was the one that was true nowhere else. It is "Username" now. The account panel is changed with it, which is beyond what the item asked for and is the point: changing only one of the two screens would have left the same value called different things depending on where you looked, which is the defect rather than a smaller version of it.

**A claim the reader cannot check (item 7).** `hashed with argon2id · never stored in the clear` sat under every password field. True, and addressed to somebody trying to think of a password — it asks them to evaluate an assertion about server internals in exchange for nothing they can act on. Deleting it took the `aria-describedby` with it: the hint carried the `-rules` id that the input pointed at whenever the strength list was hidden, so the two-way conditional became three-way. **A dangling `aria-describedby` is worse than none**, because the screen reader announces nothing and there is no way to tell from outside that it was meant to.

**Three pieces of filler on `/admin` (item 8).** An intro paragraph restating the heading and the form beneath it; a hint explaining the master password to somebody who by definition already has it; a "locked out?" note on the screen you are looking at _because_ you are not locked out. All three deleted verbatim rather than reworded, along with the `<span>` that existed only to hold the third — an empty element keeps its margin, so the card would still have ended on a gap.

The re-balance that follows is one declaration, and its selector is the interesting part. `.lw-auth-card.lw-admin-gate` is **compound on purpose**: this stylesheet nests inside `.excalidraw`-free page context but the intro rule it adjusts is `.lw-auth-card__intro`, and a single class would have tied — the same specificity trap invariant 12 records for the sheet width. It is also scoped by `h1:only-child`, so a session that adds a "Signed in as…" line falls back to the shared rhythm with no second rule to keep in step.

**A follow button that could only be pressed (item 12).** The pipeline worked end to end and had for months. What did not was every part a person touches: `follow()` only ever _set_ `userToFollow`, so clicking an already-followed avatar re-set an identical value and the only exits from follow mode were panning the canvas or the followee leaving. Nothing in Lawha's chrome ever _read_ `userToFollow` or `followedBy`, so there was no sign you were following anyone — or that anyone was following you, on the surface that lists those people. And your own avatar was a `<button>` whose handler returned immediately: it took focus, invited a click, and answered with nothing. It is a `<span>` now.

The state is announced three ways because a ring is not one: `aria-pressed` on the toggle, a label that switches to "Stop following", and a named exit control in the count slot. The count slot puts _following_ ahead of _followed by_, since following changes what your own canvas does — your viewport is not yours while it is on — and being followed changes nothing you see. It also prefers the live presence name over `userToFollow.username`, which is a snapshot taken at click time and goes stale if that person renames themselves.

**Two follow surfaces on a phone, and only one was hidden.** `lawha-editor.scss` retired upstream's `UserList` in the canvas top-right the day it was written. `MainMenu` renders its _own_ copy on a phone, with its own working follow toggle — so a phone showed Lawha's stack and upstream's list at once, each with its own idea of who you were following. Hidden the same way.

**And the `.follow-mode` badge is skinned, with one thing deliberately not set.** It used upstream's `--color-primary-*`, which is Excalidraw's violet and the one obviously-not-Lawha thing on screen while follow mode is on. The selector is doubled — `.follow-mode.follow-mode` — because this file nests inside `.excalidraw` and upstream's rule is `.excalidraw .follow-mode`, identical specificity, import-order roulette. **`background` is not set on `.follow-mode` itself**: it is a transparent, `pointer-events: none` overlay stretched across the whole viewport whose only paint is a 2px border, so a background there tints the entire canvas. The badge inside it does take one, which is exactly the wrong lesson to draw from.

---

## 5. Known issues and deferred work

1. ~~Board rename does not persist to the server.~~ Fixed: `LawhaBoardTitle` PATCHes on commit, best-effort, skipped on the scratch canvas.
2. **Long-outage reconnect is unverified.** Reconnection on localhost is near-instant, so the tested drop window was short. Convergence is proven; a multi-minute outage is not.
3. ~~**Presence names still lag for peers who have not moved.**~~ Closed by the identity event (ADR 0006). Excalidraw only transmits a username inside pointer and idle payloads, so a peer who had not moved showed as "Joining…". The server now announces every member's name on join, before anyone has moved a pointer — including link guests, who get a stable placeholder rather than a blank. Pinned by `identity.test.ts` ("names a signed-in peer from the account, not from the socket", "announces identities to the room when someone joins") and, on the client, by `lawhaIdentityPinning.test.tsx`, which is where the merge direction that could have undone it now lives.

   > **The citation here was wrong until §4.12.** It read "and, on the client, by `lawhaIdentity.test.tsx` (**"keeps a name a pointer payload already delivered"**, which is the merge direction that could have undone it)". That test pins the _harmless_ direction — an identity arriving second must not blank a name a pointer already delivered. The direction that could have undone it, and did, is the opposite one: a pointer payload arriving second overwriting the name the server announced. Nothing pinned that until `lawhaIdentityPinning.test.tsx`. Cite the test that fails when the bug returns, not the one next to it in the file.

4. **`ShareDialog.tsx` is mounted but unreferenced.** Delete it once `onExportToBackend` (the shareable-link export) has a new home in the main menu.
5. ~~`LAWHA_REQUIRE_AUTH=false` is the default.~~ It defaults to **true** now. An unauthenticated visitor is refused rather than handed the shared `anonymous` identity. Link visitors are a separate, narrower principal — see invariant 22.
6. ~~No Playwright.~~ `e2e/` holds a visual suite (3 viewports x 2 themes, 36 baselines) plus behavioural specs. `yarn test:visual` / `yarn test:visual:update`, and `docs/visual-regression.md`. Point `LAWHA_E2E_BASE_URL` at the https origin when the dev server runs with TLS.
7. **Account deletion takes shared boards with it.** Ownership transfer still does not exist, so the UI says what actually happens. `board_members` has routes now, so this is finally buildable.
8. **`GET /api/auth/me` 401s in the browser console** when signed out. Expected — "no session" is an ordinary state here, not an error — but it is noise.
9. Port 3002 is occupied on this machine by an unrelated app, hence the gitignored `.env.development.local` pointing the dev proxy at 3007.
10. ~~The PWA manifest still says "Excalidraw".~~ Rebranded. Icons are unchanged — there is no Lawha artwork.
11. ~~The service worker precaches ~60 chunks.~~ Down to 17. Mermaid's diagram chunks load on demand; the core shell is still precached, verified by walking the static import graph.
12. **Solo boards are still local-only until shared.** A board opened from the dashboard now joins its room and therefore persists to the server, so this is mostly closed — but `/` for a signed-out user is still a scratch canvas backed only by `localStorage`.
13. ~~`HomeRoute` uses `window.prompt` and `window.confirm`.~~ Fixed in place on the card. The stop-session `window.confirm` in `Collab.tsx` is gone too.
14. ~~One native dialog survives.~~ None do. A sweep of every `.ts`/`.tsx` under `excalidraw-app` finds no `window.alert`, `confirm` or `prompt` at all. There were three left, not one — the decrypt failure in `Collab.tsx` and two in `importFromBackend`. Note that the count was asserted from memory twice and was wrong twice. Sweep, do not recall.
15. ~~**A view-only guest cannot be told apart from a signed-in viewer in the presence stack.**~~ Fixed with the identity event (ADR 0006): `isGuest` comes from the server, the stack draws a "G" badge, and the accessible label says "(guest, no account)" — the badge alone would have been visual-only, and who you are sharing a board with is not a decorative fact. Guests are also individually named now (`Guest Heron`), because every one of them being "Guest" made two visitors indistinguishable from one person with two tabs.
16. **`docs/lawha-roadmap.md` drifts.** Four claims in this file were false by the time anyone read them — the auth default, the Playwright note, the native-dialog claim, and the thumbnail note. If a section describes behaviour, it is a claim, and claims rot. Prefer pointing at a test.
17. **Four `Assistant-*.woff2` requests 404 in a production build.** `packages/excalidraw/fonts/fonts.css` declares `@font-face` for them and the woff2 plugin rewrites that file at build time (invariant 7), but the files are never emitted — the built CSS asks for `/assets/Assistant-*.woff2` and the build puts nothing there. Inherited, not ours: we have never touched `scripts/woff2/` or `public/fonts/`, and Lawha's own self-hosted fonts (`caveat`, `ibm`, `space`) ship correctly alongside 301 others. No visible impact either, because `--lw-font-sans` resolves to Space Grotesk, which loads; `Assistant` is only a fallback behind it. Noise in the nginx log, and the kind of thing that only shows up in a real production run — the dev server never surfaced it.
18. ~~**Sixteen visual baselines are stale and have not been regenerated.**~~ **Done, and the reason nobody could do it was not the one this entry kept giving.** The suite was not being skipped out of caution — it _could not run_. `auth.setup.ts` waits for the `load` event on a 30s budget, and `load` was firing at **30,038ms** because four fonts were being fetched from a CDN this machine cannot reach (ADR 0016). The setup project timed out, so every visual project was skipped, so the baselines drifted for batch after batch while this entry counted them.

    With the fonts served locally, `load` is 143ms and the suite runs. Regenerated against the Docker stack with the diffs actually looked at, which is what this entry asked for: the auth screens still claimed **"Boards are end-to-end encrypted"** (a baseline older than ADR 0012), the dashboard predated the Tags button, and the account panel predated the colour picker. Every diff was the baseline being behind. **10 updated, 6 deleted with the `canvas-signed-out` test, 32 green.**

    The standing warning survives and is the reason this is not closed outright: the suite screenshots whatever `LAWHA_E2E_BASE_URL` names, so regenerating against a dev server silently replaces a deployment baseline with a development one. Always `LAWHA_E2E_BASE_URL=https://localhost`.

    **§4.17 adds the six `dashboard-*` baselines again, and this time the increment is counted rather than left open.** Both views changed what they draw for a locked board: the Tiles card gained a `__plate` wrapper and moved its padlock note out of the disabled preview button, with an "unlock" link now inside it, and the Details row gained a locked note that had no rendering at all before. A baseline only moves if it has a locked board in it, so the count is an upper bound on the six, not an addition to the total below.

    **After §4.14 it is more than sixteen, and the increment was not counted.** That batch moved the editor's main-menu trigger up into the app bar's row (a CSS lift, no `packages/` edit), removed the sync pill from the footer, and let `.selected-shape-actions-container` rise by the freed 40px — all four `board-canvas-*` baselines change, and the desktop and tablet ones change in two places rather than one. Nobody re-ran the suite, for the reason above: the visual suite screenshots whatever `LAWHA_E2E_BASE_URL` names, and a baseline regenerated against a build nobody looked at is a regression blessed as the new normal. Re-baseline deliberately, with eyes on the diff, and count them then.

19. ~~**`GET /api/admin/config` has no UI.**~~ It has one: `excalidraw-app/lawha/admin/LawhaServerConfigCard.tsx` renders all nine fields on `/admin`, above the account list. The master password is rendered as "Configured" / "Not set" and the field it comes from is typed `boolean` on the client, which is the client's half of the contract that a hash never crosses this wire.
20. **Invariant 10's count is stale: `packages/` diverges in thirteen paths, not four.** Measured, not recalled — `git diff --stat $(git merge-base upstream/master main)..main -- packages/`. The invariant's own sentence already names five paths while saying "four files", so the number has never quite matched its own list. What is actually there:

    | Path | Recorded where |
    | --- | --- |
    | `excalidraw/clients.ts` | invariant 10, ADR 0001/0002/0003/0006 |
    | `common/src/colors.ts` | invariant 10, ADR 0001 |
    | `excalidraw/types.ts` | invariant 10, ADR 0002/0006 |
    | `excalidraw/index.tsx` | invariant 10, ADR 0002 |
    | `excalidraw/laserTrails.ts` | invariant 10, ADR 0002 |
    | `excalidraw/renderer/interactiveScene.ts` | ADR 0001's _Affects_ line — passes `appState.theme` into `getClientColor`. Never counted |
    | `excalidraw/tests/clients.test.ts` | this list, previously as "a fifth file". It is the test for `clients.ts` and will conflict alongside it |
    | `excalidraw/locales/en.json` | **nowhere.** Two keys, `collabAuthRequired` and `collabForbidden` — the strings invariant 24 is about |
    | `excalidraw/vite-env.d.ts` | **nowhere.** Drops `VITE_APP_FIREBASE_CONFIG`, left over from removing Firebase |
    | `excalidraw/components/App.pan.ts` | ADR 0013. New file — pan momentum |
    | `excalidraw/components/App.tsx` | ADR 0013. **The only one of the four that can conflict**, and the ADR enumerates its five hook points for exactly that reason |
    | `excalidraw/tests/appPan.test.ts` | ADR 0013. New file |
    | `excalidraw/tests/rightDragPan.test.tsx` | ADR 0013. New file |
    | `excalidraw/mermaid.ts` | ADR 0028. **Was 0 lines of diff and is 20.** Five diagram-type keywords Mermaid 11 added, missing from the paste heuristic |
    | `excalidraw/components/TTDDialog/MermaidToExcalidraw.tsx` | ADR 0028. **Was 0 and is 20.** The `stateLink` the description string had no wiring for |

    | `excalidraw/components/TTDDialog/TTDDialog.tsx` | ADR 0028. Was 0, now 23 — the converter loader indirection |
    | `excalidraw/components/TTDDialog/mermaidLib.ts` | ADR 0028. **New file**, so free at merge time |
    | `element/src/transform.ts` | ADR 0028. Was 0, now 205 — `table`/`tensor`/`code` in the element-skeleton API, and an arrow can bind to them |

    **Re-measured 2026-08-25 after the ADR 0029/0030 batch: `packages/` diverges in 71 tracked paths — 22 added, 49 edited — 11,120 insertions** (was 63 / 9,444 before ADR 0027, then 71 / 10,456 once the mermaid batch was committed). ADR 0030 added **no new paths at all**: every tensor change lands in a file ADR 0026 already touched, and ADR 0029 is entirely outside `packages/`. The `mermaid*` and `TTDDialog/` rows are the ones that matter, because every one of those files was at *exactly zero* before and the directory was pristine upstream. `App.tsx` grew by two lines — an import and one changed expression. The converter itself is ~2,750 lines in `excalidraw-app/lawha/mermaid/`, which upstream does not have and never will, and therefore costs nothing at merge.

    None of the three unrecorded ones is a mistake — each is small, deliberate and consistent with an ADR — but an upstream merge is planned against a number, and the number was wrong. Fix the count when someone next opens invariant 10 for a real reason; do not let a stale figure be the argument for adding "just one more".

    **The last four were added deliberately, with the ADR the invariant asks for, and they change the shape of the problem rather than just the count.** Everything above this line is an edit to a file upstream also has, so every one of them is a merge conflict waiting. Three of the four new ones are files upstream does not have and never will, which cost nothing at merge time. The distinction is worth keeping when the next person weighs an addition: _where_ the divergence lands matters more than how many paths it spans, and `App.tsx` — upstream's largest and most-edited file — is the expensive kind.

21. ~~**Docker builds are not reproducible.**~~ Fixed. `lawha-server/yarn.lock` is committed and both install steps in `lawha-server/Dockerfile` now pass `--frozen-lockfile`, so drift between the lockfile and `package.json` **fails the build** instead of silently re-resolving.

    **The lockfile has to be generated standalone, and that is the part worth writing down.** `lawha-server/` is a yarn workspace member, so `yarn install` run inside it resolves against the ROOT lockfile and writes nothing there — while the image copies `package.json` alone and installs in isolation. Regenerate it the way it was made: copy `lawha-server/package.json` into an empty directory, `yarn install --ignore-scripts`, bring the `yarn.lock` back.

    Why it mattered more than tidiness: `lawha-backup` runs this same image, so a drifting transitive meant the better-sqlite3 that **writes** your backups could differ from the one that **reads** them on the day you need it to.

22. ~~**The restore half of backup/restore has never been exercised.**~~ **It was worse than unexercised: the documented procedure destroyed the database.** Its step 2 was `docker volume rm excalidraw_lawha-data`, and somebody followed it. Replaced wholesale in §4.13 — the named volume is gone, the `docker volume` step is gone, and both halves are now scripts with tests (`lawha-server/scripts/backup.mjs`, `restore.mjs`, nineteen tests in `scripts/*.test.mjs`). The ownership hazard this entry used to name went with the volume: the host user and the container's `node` are both uid 1000, so there is no root-owned extraction any more.

    **The restore has now been rehearsed against real data, on a copy.** `cp -a ~/lawha-data` to a scratch directory, `LAWHA_DB_PATH` pointed at the copy, newest archived backup restored into it: 11 users, 21 boards, 19 board_scenes, 10 files, **identical counts on both sides** — the drift check that would have caught a partial file passed — plus `integrity_check: ok` on the result and the `.pre-restore-<stamp>` original left in place. The live directory was untouched and the stack stayed healthy throughout. Rehearsing on the machine holding the only copy is how the rehearsal becomes the incident, so the copy is not a convenience, it is the procedure.

    The free check survives and is still the first thing to run afterwards: `docker compose logs lawha-server` must show **no** first-boot administrator banner. That banner means zero accounts, which means it is not looking at your data.

23. **Two of §4.12's five fixes are unpinned.** The three that could change what crosses the wire or comes out of the database each got a test next to the line that refuses — `avatar.test.ts`, `lawhaIdentityPinning.test.tsx`, `folders.test.ts`. The two low-severity ones did not. The folder rail's missing React key has no runtime effect and was a development-console warning only, which is a fair reason to skip it; the dashboard selection bar's `isBulkRunning` lock has no assertion that a running bulk delete disables its own button, which is not. `LawhaHomeSelection.test.tsx` already renders that bar and is where it belongs. Left open rather than waved away, because "it is obviously right" is the argument that kept `canEdit` unenforced for months (invariant 21).

24. **One test in `collabBoardReopen.test.tsx` passes against the unfixed code.** "does not take a peer's empty `SCENE_INIT` for the board's scene" mounts a _single_ board, and on the first board of a page session `App.initializeScene` reads storage itself, so the old code shows the stored rectangle too. The other two tests in that describe block — the ones that open a second board — fail hard without the fix, so the bug is pinned; this one is a forward-looking assertion about the empty-INIT rule, not a witness to the defect. Either give it the two-board shape its siblings have, or leave it and know what it is. Recorded because this repository has shipped a regression test that passed both ways before, and the way that happens is nobody writing down which ones do.

25. ~~**The server suite runs twice.**~~ Fixed. `lawha-server/tests/**` is excluded at the root, beside `e2e/**` and `lawha-server/scripts/**`. `yarn test:app` went from 179 files / 2589 tests to **154 / 2176** — the difference is exactly the 25 files and 413 tests that `yarn test:server` already owns, so nothing stopped being covered.

    It was left alone once before on the grounds that reducing what `yarn test:app` covers is not a thing to do quietly. It is not quiet here: the counts above are the check, and the reason to do it before it bit is that the first server test reaching for a node-only global would have failed in jsdom, in an environment it was never written for, naming the app.

26. **A touch drag has never been exercised against a real finger.** `useBoardDrag` starts one on a 400ms hold and cancels it if the pointer moves more than 8px first, so a flick still scrolls the grid. Both numbers were chosen by argument, not measurement, and jsdom cannot tell you whether they are right — the tests drive `pointerType: "mouse"`. The failure mode if the hold is too long is that the feature reads as broken; if it is too short, the page becomes hard to scroll. Try it on the phone before trusting either.

27. **`LawhaAuth.test.tsx`'s avatar test is flaky, and it is not the escrow work's fault — measured, not assumed.** "PUTs the raw bytes and re-reads the account for the new id" failed **3 runs out of 3 on a stashed, unmodified checkout** while this was being diagnosed, so it is pre-existing. Two separate causes were found and only one is fixed:

    - **CPU starvation.** The app suite saturates the machine by itself — 177 jsdom files, and a load average near **37 on 28 cores** was measured during a run. The file completes in ~1.4s when it passes, so nothing in it is slow; its worker is simply descheduled for seconds. Fixed by raising two deadlines, and **both** were needed: `waitFor`'s own 1000ms default _and_ vitest's separate 5000ms per-test budget. Raising only the first swaps the failure for `Test timed out in 5000ms`, in which the assertion never runs at all — which reads like a new bug rather than the same one.
    - **A real race, still open.** With the deadlines raised the failure rate fell to roughly 1 in 4, and the survivor is a different failure: `AssertionError`, image absent after the full 20s, not a timeout. Something in the avatar re-read path intermittently does not re-render. Nobody has chased it; it is in `LawhaAccountPanel`, not in anything §4.19 touched.

    Three wrong diagnoses were made before the right one, all plausible, all disproved by reverting: that the escrow client's new `console.warn` was the cost; that a fixture routing `/api/keys` made every sign-in run a real 600k-iteration PBKDF2; and that adding a 178th test file tipped the worker pool over. The third looked especially convincing because the suite really did start failing when a file was added — but the load average had been climbing across the session, and the clean tree failed identically once it was high enough. **A flake that correlates with your change is not thereby caused by it; stash and re-run before believing the correlation.**

28. **Of handoff items 9, 10 and 11, only 11 is untouched.** This entry said all three were outstanding and that stopped being true in the same session — known issue 16, on schedule.

    - **9 — admin-initiated password reset: DONE, and simpler than either plan.** The original called for a token table and a redeem link, so `recoverEscrow` could re-wrap under a recovery code. ADR 0011 replaced that with a server-held copy of each master. **ADR 0012 then removed the encryption entirely, so there is nothing to re-wrap at all** — an administrator presses **Reset password** beside an account, the server writes a password hash and revokes that account's sessions, and the person signs back in. The sentence this entry used to carry, that "the server re-wraps the master under the generated password before changing it", described machinery migration 013 dropped. No token table, no re-wrap, and no account that cannot be helped. ADR 0015 rebuilt the surface around it.

      **And then, 2026-08-07, the token table came back after all — for a different reason than the one it was dropped for** (ADR 0021, migration 017). Not to re-wrap anything: there is still nothing to re-wrap. Because an administrator who writes a password **knows** it, and the audit row that follows cannot then say the account holder did anything. So `POST /admin/users/:id/password` is removed — it 404s — and in its place `/admin` mints a one-time `/reset/<code>` the owner redeems themselves. The two sentences above are the record of how this got here; the current answer is "no re-wrap, and a token table".

    - **10 — cursor identity: HALF done.** A peer with no picture draws their **initial** rather than a crewmate (§4.22); guests keep the crewmate, because they have no account to take an initial from. What was NOT built is the three-way `cursorIdentity` setting from the plan — there is no `generated` glyph option, no migration `011`, and no ADR 0011 of its own (that number went to the escrow). Only worth finishing if the third option is actually wanted.
    - **11 — right-click context menus off the canvas: NOT STARTED.** A right-click on the dashboard still gets the browser's menu. `packages/excalidraw/components/ContextMenu.tsx` is not reusable — it needs `useExcalidrawAppState`, dispatches only `Action`s, and sizes itself from the editor viewport rather than the page. The plan is to extend `LawhaPanel` with a virtual anchor, lift the Escape/focus-trap/focus-return contract from `home/LawhaModal.tsx`, and give `useLawhaContainer` a page fallback. **Invariant 12 applies directly**: the new class must be added by name to the compound-selector list in `LawhaPanel.scss` or it silently inherits the popover's 330px width. Every handler it needs is already assembled in `HomeRoute.tsx`.

29. ~~**The visual baselines are further out of date.**~~ Folded into known issue 18, which is now done. This entry and that one had been counting the same drift from two directions for several batches, neither noticing that the suite had not executed since before the count started — see ADR 0016. **Two entries tracking a number that nobody could measure is worse than one**, and the lesson generalises: when a known issue keeps getting re-stated with a larger number, check that the thing producing the number still runs.

30. **The behaviour specs leak accounts, and it showed up as a UI problem.** `openBoards.spec.ts` and `twoAccounts.spec.ts` register `qa-*` and `pw-*` accounts on whatever server they are pointed at and never delete them; `auth.teardown.ts` only cleans up the one account the _visual_ projects share. Six runs against the live stack in one session took it from 48 accounts to 70 — and the rebuilt `/admin` renders every account as a full row with four buttons, so finding a real person meant scrolling past thirty throwaways.

    Two consequences, and only one is fixed. `/admin` gained a search box (ADR 0015), which it needed anyway. The leak itself is **fixed only in `inviteCodes.spec.ts`**, which deletes each account it makes through `DELETE /api/auth/me` — the same call `auth.teardown.ts` uses — and was measured doing it: 70 accounts before a four-test run, 70 after. The other two specs are untouched, deliberately, because changing what a passing suite does to a live database is not a thing to slip into an unrelated batch. Do it on purpose, or accept that anything pointed at a real deployment leaves rows behind.

    The 17 accounts this session created were removed by hand afterwards (`integrity_check ok`, no foreign-key violations). That is not a procedure; it is what a missing teardown costs each time.

---

## 6. Running and verifying

```bash
# Terminal 1 — collaboration server
cd excalidraw
LAWHA_PORT=3007 LAWHA_HOST=0.0.0.0 \
LAWHA_DB_PATH=./lawha-data/lawha.db LAWHA_FILES_DIR=./lawha-data/files \
LAWHA_REQUIRE_AUTH=false \
corepack yarn --cwd lawha-server dev

# Terminal 2 — app (proxies /api and /socket.io to the server)
corepack yarn --cwd excalidraw-app vite --host 0.0.0.0 --port 3001
```

Only 3001 needs to be reachable. `corepack yarn`, not `yarn` — it is not on PATH here. For a Tailscale MagicDNS hostname rather than the IP, set `LAWHA_ALLOWED_HOSTS`; bare IPs are allowed by Vite already.

### The code graphs re-index themselves

`.husky/post-commit` runs `scripts/refresh-graphs.sh` after every commit. It detaches immediately so no commit waits on it, takes a lock, skips mid-rebase and mid-merge, and exits 0 on every path — a housekeeping hook that fails a commit is just a frightening message after a successful one.

`core.hooksPath` is `.husky`, so `.git/hooks/` is never consulted; a hook placed there will not run.

The lock is the point of the script rather than a nicety: the GitNexus index has been corrupted three times with `FTS index 'file_fts' is inconsistent`, twice on a manual run and once after four incremental ones.

That failure now **repairs itself** — a full clean and rebuild, once, and only for that message. It is safe to do automatically because this index is not data: every node in it is derived from the tree by `analyze`, so a rebuild costs a couple of minutes of CPU in a background process nobody is waiting on. Any other failure is reported and left alone, because "delete it and try again" is not a general answer to an unknown error.

graphify is refreshed with `graphify update` (code only, no LLM key). The full `--update` also extracts documents and images, which needs a key; without one those nodes are dropped, so the hook deliberately does not run it and shrink them silently.

```bash
corepack yarn test:app --watch=false   # 154 files, 2330 passing (2378 collected, 47 skipped, 1 todo)
corepack yarn test:server              # vitest (18 files, 298 tests), then `node --test scripts/*.test.mjs` (19)
corepack yarn --cwd lawha-server test:scripts   # the backup/restore half alone
corepack yarn test:typecheck
corepack yarn test:code
corepack yarn test:other               # prettier; its ignore list is .eslintignore, not .gitignore
```

**The test that matters most** is two browsers against a real server: bidirectional element sync, remote cursors with names, presence avatars, and a genuine transport drop (`socket.io.engine.close()` — a manual `disconnect()` never fires `reconnect`, so the recovery path would not run). Both sides must end with identical element ids and nothing lost.

Note that `window.h` only exists in dev builds, so probes against a production bundle read empty. And Vite's HMR reloads the page when the network drops, which wipes the scene and looks exactly like a lost merge — drop the socket transport, not the network.
