# ADR 0007 — A folder tree, dashboard modals, and exactly one way to share

**Status:** accepted **Affects:** `lawha-server/src/db/migrations/006_folder_tree.sql`, `lawha-server/src/db/repositories/folders.ts`, `lawha-server/src/http/routes/folders.ts`, `lawha-server/src/protocol.ts`, `lawha-server/src/socket/liveAccess.ts`, `lawha-server/src/socket/rooms.ts`, `excalidraw-app/lawha/home/**`, `excalidraw-app/components/AppMainMenu.tsx`, `excalidraw-app/components/AppWelcomeScreen.tsx`, `excalidraw-app/share/ShareDialog.tsx` **Amends:** ADR 0002's "an index, never a hex" rule, applied here to folders

## Context

The dashboard was a flat rail of folder chips. Folders were per person and could not nest, so "Platform / Sync engine / Protocol" was three unrelated chips, and the only way to file a board was a chip-picker in the selection bar.

Separately, there were **two** ways to start a live session, and they did different things.

## Decision

### 1. Folders nest, and names are unique among siblings

Migration 006 adds `parent_id` and `color_index`.

The unique index is the whole of the interesting part. Migration 005 had `UNIQUE (owner_id, name)`, and the obvious replacement — `UNIQUE (owner_id, parent_id, name)` — is **silently wrong**: SQLite treats NULLs as DISTINCT in a unique index, so two root folders both named "Clients", both with `parent_id NULL`, would not collide. That is exactly the outcome the 005 index existed to prevent, quietly undone by the migration meant to preserve it. Two partial indexes split on the NULL-ness of `parent_id` instead, so every row lands in exactly one of them and each gets the comparison it needs.

`parent_id` carries **no `ON DELETE` action**, deliberately. SQLite's default is `NO ACTION`, so deleting a folder that still has children _fails_ — and that is the point: `FoldersRepository.delete` reparents first, and a future call site that forgets gets an error rather than a subtree pointing at a row that no longer exists.

**Deleting a folder promotes what it held up one level.** It never deletes a board; it could not undo that if it were wrong, because the server has never held a key. For a _root_ folder promotion is identical to the old "the boards become unfiled", so nothing about the top level changed under anybody. Promoting a child can collide with a name already sitting in the parent, and the promoted child is renamed `Drafts (2)` rather than the delete being refused — an unrelated name clash must not block an action the owner has every right to take, and dropping the index would leave two folders they cannot tell apart.

`color_index` is an **index into `COLLABORATOR_PALETTE`, never a hex.** ADR 0002's rule, for ADR 0002's reason: the dashboard draws a folder in both themes and a colour picked against one is wrong in the other. Those twelve entries were already chosen so a filled chip clears WCAG AA in both, which is exactly the job. `hex` and not `hexDark` — a folder tile is DOM, and only the interactive canvas is colour-filtered.

The server bounds `colorIndex` to `0-255` rather than to the palette's length, so a thirteenth colour can ship without a migration. That makes an unrecognised index an **expected input** on the client, and `folderColor` falls back to a neutral rather than indexing blindly. It asserted non-null once; the result was a blank dashboard behind an error boundary, reported as an unrelated jotai error from the `<Trans>` the boundary rendered.

### 2. Subtree counts are derived on the client

`FolderSummary.boardCount` stays what it was: the server's count of boards filed **directly** in a folder, computed with the same access predicate `BoardsRepository.listForUser` uses.

The sidebar wants _subtree_ counts, and derives them from the board list it already holds. The reason is not performance: a count computed from the same array the grid renders **cannot disagree with the grid**, and a folder that says "3" over an empty page is a bug the user can neither explain nor clear. The server's count keeps its own job — it is the one that knows about access, and the list it feeds is already filtered by it.

### 3. Shape counts exist only on the device that can decrypt

The server holds ciphertext and has never been able to count anything. The dashboard already decrypted each board's scene to draw the preview, so that decrypt now returns a count as well, cached per **board revision** (`boardId:updatedAt`) — scene writes bump `boards.updated_at`, so drawing on a board and returning to the dashboard re-decrypts, which a cache keyed on the id alone would not.

Three states are kept apart and the distinction is load-bearing: _not decrypted yet_ (absent from the map), _decrypted and unreadable here_ (present and null), _readable_. A board with no key on this device is **unknown, not empty** — it says so, and "Most shapes" sorts it **last** rather than treating an unknown count as zero, which would assert something false about a board that may well be full.

### 4. The dashboard may float; the canvas may not

Import, Export and Tags are modals over a scrim, and the selection bar is fixed to the bottom of the viewport. Both reverse earlier decisions in those very files, and the reversal is **dashboard-only** — the canvas chrome is untouched and the "everything inside the app's own chrome" rule still holds there.

Two arguments changed:

- The old selection-bar comment said a floating bar covers the cards you are checking your selection against. True, and worth less than what it cost: a selection is usually built while scrolling a long grid, and an in-flow bar scrolls away with the filters, so by the time the last board is picked the controls are off screen. `.lw-home` carries bottom padding so the last row still clears it.
- Import, Export and Tags are transient tasks with nowhere on the page to live. Each is a short form that is finished and dismissed; a permanent strip for each would push the boards off the first screen.

**None of them is a native dialog** (invariant 19). `LawhaModal` traps focus, closes on Escape, and returns focus to whatever opened it.

### 5. A rename reaches the room, on the server's own event

`SERVER_EVENTS.LAWHA_BOARD` carries `{ boardId, name }` to everyone in a board's room when `PATCH /api/boards/:id` changes the name.

Server-authored for ADR 0006's reason: it is a fact about the board rather than about the sender, so a peer must not be able to rename someone else's board by claiming it did. The permission is enforced at the write — a viewer's PATCH is 403 and nothing reaches the room — and the broadcast is downstream of that rather than beside it.

**Only the name.** Link access deliberately does _not_ ride here: it already has a complete path through `applyBoardAccessChange`, which re-resolves each socket's permission and evicts or demotes it. Carrying the same fact on a second, weaker channel would give clients two answers to one question and a reason to trust the one that cannot enforce anything.

The client checks the board id rather than trusting it. A socket survives being moved between rooms on a reconnect, and applying a stale announcement would rename the board you just opened to the name of the board you just left.

### 6. One share surface

`MainMenu.DefaultItems.LiveCollaborationTrigger`, the welcome screen's equivalent, the two command-palette entries and upstream `ShareDialog`'s `collaborationOnly` mode are all gone. Sharing is the top bar's Share panel, and only that.

Not merely redundant. That path called `collabAPI.startCollaboration(null)` and handed out a link with **no owner check at all**, while the Share panel gates link access on `isOwner` and the server refuses a non-owner's change outright. Invariant 21 in its usual shape: a rule enforced in three places and bypassed in a fourth is not enforced.

The everyday failure was worse than the security one. That dialog's "Stop session" called `stopCollaboration`, which leaves the room and does **not** turn sharing off — so someone who pressed it had every reason to believe they had stopped sharing a board that anyone holding the link could still open.

**What this cannot do, stated plainly:** the room key rides in the URL fragment, so anyone who can open a board can copy the address bar. Removing the button prevents an accident, not an adversary. The enforcement that matters is link access and membership, both server-side. Nothing in the UI claims otherwise.

Joining is not sharing: opening `/b/<id>` still joins that board's room whichever way it was reached (invariant 25). Only the handing out is gated.

`ShareDialog`'s other mode — export a snapshot to a shareable link — is left standing. It does not work on this deployment either, because `.env.production` blanks the four off-box URLs on purpose, and that file says in as many words that removing the entry point was _not_ that change. It is not this one either. Two decisions, kept separable.

## Consequences

- `LawhaFolderRail.tsx` is deleted. `LawhaFolderSidebar.tsx` replaces it.
- `AppMainMenu` and `AppWelcomeScreen` no longer take collaboration props at all, so a future re-introduction has to be deliberate rather than a prop passed back in.
- A test that pins "how many migrations ran" must stage a fixture directory. `migration005.test.ts` asserted `applied === 1` against the _live_ directory and 006 turned that into `expected 2 to be 1` while proving nothing about 005 — a failure mode where tests drift out of sync with the code they measure.
- Drag and drop is an **accelerator, never the mechanism**. `dragstart` does not fire from a touch and there is no keyboard equivalent, so every move it enables is also reachable from "Move to folder…" in the selection bar. If the two ever diverge, the pointer-only path is the one that is wrong.
- A drop target that does not call `preventDefault` in its **own** `dragover` is not a drop target: `drop` never fires, nothing logs, and the only symptom is a cursor that says no. `LawhaHomeFolders.test.tsx` asserts the prevention itself rather than only the outcome, because no "did the PATCH happen" test can tell that apart from a handler that ran and declined.
