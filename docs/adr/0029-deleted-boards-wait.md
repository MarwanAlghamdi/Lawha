# 0029 — A deleted board waits thirty days, and a purged id is spent for ever

**Status:** accepted.

**Affects:** `lawha-server/src/db/migrations/{019_trash_retention,020_purged_boards}.sql`; `lawha-server/src/db/repositories/{boards,users}.ts`; `lawha-server/src/lib/trashSweep.ts` (new); `lawha-server/src/http/routes/{boards,scene,admin}.ts`; `lawha-server/src/http/middleware/errors.ts`; `lawha-server/src/{config,index}.ts`; `excalidraw-app/data/boards.ts`; `excalidraw-app/lawha/home/{HomeRoute,LawhaTrash,LawhaFolderSidebar,LawhaBoardActions,LawhaSelectionBar}.tsx`; `excalidraw-app/lawha/admin/LawhaServerConfigCard.tsx`; `lawha.env.example`, `docs/configuration.md`, `docker-compose.yml`.

## Context

`boards.deleted_at` has existed since `001_init.sql`. It has never meant anything but "hidden": every read filtered `deleted_at IS NULL`, no screen listed the hidden rows, and nothing ever removed them. It was a tombstone with no gravedigger and no way back.

The way back mattered first. Somebody on this deployment deleted a board they wanted, and getting it returned meant an operator opening the database by hand and clearing a timestamp. That worked — the scene blob was intact at revision 2031 and all ten images were still on disk — and it is not a recovery procedure, it is the absence of one. The data was never gone; the product simply had no sentence for "put it back".

The other half was quieter and worse. Because nothing removed the rows, a deployment's storage only ever grew, and the growth was invisible: a board deleted in 2024 still held its scene, its `files` rows and its directory of uploaded images, and no screen anywhere would ever mention it again.

## Decision

**Deleting a board starts a clock instead of hiding it for ever.** The board appears in a Trash view on the dashboard, where its owner can restore it or destroy it now. When `LAWHA_TRASH_RETENTION_DAYS` (default 30) has passed, an hourly sweep destroys it: the row, everything cascading from it, the `files` rows, and the directory on disk.

Four decisions inside that are worth recording, because each was a place the obvious answer is wrong.

### 1. `0` means "kept for ever", not "purge now"

The same convention as `LAWHA_SESSION_TTL_DAYS` and `LAWHA_BACKUP_INTERVAL_HOURS`, and here it is a safety property rather than a consistency one. The two realistic ways this setting gets a zero are an operator typing one and an operator leaving it blank for `z.coerce.number()` to coerce. Under the other reading, either mistake destroys the entire trash on the next tick with no undo. Under this one the worst case is a trash that grows.

`sweepExpiredTrash` returns before it queries at all in that case, rather than computing a cutoff of `now - 0`. A cutoff of "now" happens to select nothing only because of which way an inequality points; a `return` says what is meant.

### 2. A soft delete may not destroy anything the server cannot give back

`HomeRoute.forgetLocally` used to run on every delete and drop four things. Two of them the server reproduces on the next open, and two of them it cannot:

- **the board key** is, for the handful of boards still stored as ciphertext, the _last copy in existence_ — migration 013 dropped every server-side copy precisely because the server had nothing useful to lose (ADR 0012). Dropping it on a reversible delete means restore returns a board that opens to nothing, permanently, while the dashboard lists it as perfectly normal.
- **the undo history** lives only in this browser (ADR 0019). Nothing on the server has a copy.

So it is split. `forgetRebuildable` runs on delete and clears the scene cache and the thumbnail, which keeps the original privacy intent — the local copy goes when the board leaves the dashboard — at a cost of zero, because a restore rebuilds both. `forgetLocally` runs only from "Delete for ever", where the server has genuinely destroyed the board and there is nothing left to restore from.

This is the shape invariant 21 warns about, arriving in a new place: the screen would have looked entirely correct while the guarantee was gone.

### 3. Restore does not touch `updated_at`

The dashboard sorts on it. Bumping it would file a board restored from six weeks ago above the one worked on this morning. A restore is an event about the row's _existence_, not about its contents.

### 4. The upgrade may not destroy anything

Migration 019 stamps every row that already had a `deleted_at` forward to the moment it runs. Those rows were deleted under the old rule, where "deleted" meant hidden for ever with no way back and no screen that would ever mention them again — nobody was offered a window and nobody had a chance to use one. Without this line the first sweep, which runs at boot before the server accepts a request, destroys every board deleted longer ago than the retention window, and the operator's first sight of the feature is a log line counting what it already took.

This deployment has seven such rows and all seven happen to be inside thirty days. That is luck, it is a property of one database, and a migration may not rely on it.

The cost is that those seven read as deleted at the moment of the upgrade rather than at their real dates — a cosmetic inaccuracy on a screen that did not exist until the migration ran, in exchange for a guarantee that no board is ever destroyed without having been visibly restorable for a full window.

### 5. A purged board id is spent, and the tombstone is why

This is the one that would have shipped as a live defect.

`PUT /api/boards/:boardId/scene` runs with `allowMissing: true`. When no row exists for the id, `assertAccess` returns **before it resolves any permission at all**, and the handler creates the board — owned by whoever sent the write. That is deliberate and correct: it is how a board comes into existence.

A soft-deleted board was safe from it because its row was still there to be refused. Hard deletion removes the row, and at that instant "the board you just destroyed" and "an id nobody has ever used" become the same thing to that route. The consequences are not hypothetical:

- the owner's own editor tab, still open with a queued save, recreates the board seconds after they emptied the trash;
- anyone who still holds the link recreates it **as its owner**, because the writer is made owner.

So `purged_boards` holds the id and the date, written inside the same transaction as the `DELETE`. `POST /:boardId/access`, `POST /boards` with an explicit id, and the scene write all consult it and answer **410 Gone** — a new helper, distinct from 404 on purpose, because for a route that accepts unclaimed ids a 404 is an invitation.

The tombstones are never collected. That is the intended lifetime: the client still holding the id has no way to learn the board is gone, and the id is a link in a chat message or a pinned tab, so the window stays open for as long as anyone keeps it. A row is sixteen bytes.

`UsersRepository.deleteAccount` was given the same treatment, because deleting an account cascades its boards away and leaves exactly the ids most likely to be sitting in somebody else's open tab.

## What this also fixed

`deleteAccount` never deleted the `files` rows for the boards it cascaded away. `files.container_id` is plain TEXT with no `REFERENCES` clause (`001_init.sql:98`), so the cascade from `users` → `boards` → `board_scenes` does not reach it; the `UPDATE files SET created_by = NULL` beside it proves the table was in view when the method was written, and only its attribution column was. Those rows have been outliving their boards since the first release. `BoardsRepository.purge` gets it right, and two hard-delete paths disagreeing about one table is how a leak becomes permanent, so `deleteAccount` now does it too.

## Consequences

- **Two confirmations now say something different.** "Delete this board? … it cannot be undone" was true and is not. A confirmation that overstates the consequence is not the safe direction to be wrong in: it teaches people that the dialog exaggerates, and the one place the sentence _is_ true — "Delete for ever" — is where they most need to believe it.
- **Storage grows for up to the retention window.** A board deleted today occupies its full footprint for thirty days. That is the price of the feature and it is bounded, which is more than was true before.
- **"Purged" means purged from the live deployment.** An archive taken before the delete still contains the board (ADR 0017). Backups are a separate retention domain and this decision does not reach into them.
- **There is no record of a purge beyond stdout.** `admin_audit` was considered and rejected: every action in that table is an _administrative_ one, taken by an admin or under the master password, and a user destroying their own board is neither. The sweep prints a count and the operator's log has it. If board-lifecycle auditing is ever wanted it should be its own table, not a widened `AuditAction`.
- **A board swept by the server leaves local residue in browsers that had it open** — the key, the cache and the undo history for a board no browser will ever be told about. Explicit "Delete for ever" cleans up properly; the timed sweep has no browser present. Closing that needs an enumeration API across three stores (IndexedDB, localStorage, in-memory) that none of them currently offer, and it is left undone deliberately rather than half-done.

## Alternatives rejected

**A third `FolderFilter` variant.** The obvious way to put Trash in the sidebar is `{ kind: "trash" }` beside `{ kind: "all" }`. It was rejected because the trash is a _different list_ — different endpoint, rows that are not `BoardListEntry` — and widening that union would carry a trashed board into `matchBoards`, `sortBoards`, the selection bar and every drag handler, each one a missing `case` away from showing a deleted board on the dashboard or acting on one. It is an `isTrashOpen` boolean and a separate component instead, and the Trash row sits deliberately _outside_ the sidebar's `radiogroup`, whose label is "Filter by folder" and which this is not.

**Restoring for members, not just the owner.** Only the owner can delete a board, so only the owner can undo it. Listing an editor's trash would show them a board with every button disabled, and announce that the owner deleted it, which is the owner's business.

**Expiring the tombstones.** Reopens the resurrection hole on a schedule. See above.
