# 0024 — A link can let visitors edit, when the owner says so

**Status:** accepted. **Amends invariant 22.** A link visitor is still a narrower principal than a signed-in user — what changes is the role, never the scope.

**Affects:** `lawha-server/src/socket/authz.ts` (the root change), `http/routes/{scene,files,boards,members}.ts`, `db/repositories/boards.ts`, migration `018_guest_edit.sql`; `excalidraw-app/lawha/share/{shareModel.ts,ShareLinkAccess.tsx,LawhaSharePopover.tsx}`, `collab/Collab.tsx`, `data/boards.ts`.

## Context

`link_access: "edit"` has always meant _"any signed-in link holder can draw"_. An account-less visitor watched, whatever the link said. That was deliberate, and it was written down three times: the comment at `socket/authz.ts:115-118`, invariant 22, and ADR 0014's closing line about the one thing a code cannot do.

The request is for the owner to be able to say otherwise. The infrastructure was already there — per-socket `canEdit`, live promote/demote through `applyBoardAccessChange`, the client's view-mode plumbing, nullable attribution columns — because all of it derives from one resolver. Exactly one line said no.

## What the owner sees, and what is stored

One radio group, four options:

| Option                           | `link_access` | `guest_edit` |
| -------------------------------- | ------------- | ------------ |
| Off                              | `none`        | 0            |
| Can view                         | `view`        | 0            |
| Can edit                         | `edit`        | 0            |
| **Can edit, including visitors** | `edit`        | **1**        |

**A new column, not a fourth enum value, and the reason is not taste.** `link_access` carries `CHECK (link_access IN ('none','view','edit'))` from `001_init.sql:42`. SQLite cannot alter a CHECK constraint; widening it means rebuilding `boards` — create, copy, drop, rename. Six tables reference `boards (id)` with `ON DELETE CASCADE`, `db/index.ts:279` sets `PRAGMA foreign_keys = ON`, and `db/migrate.ts:75` runs migrations **inside a transaction**, where `PRAGMA foreign_keys` is a no-op because SQLite refuses to change it mid-transaction. The DROP would therefore cascade through `board_scenes`, `board_members`, `board_invites`, `files` and the folder links and take the deployment's data with it. There is no table-rebuild precedent in that directory; 003 used `ALTER TABLE` and so does 018.

**Existing boards do not move.** `guest_edit` defaults to 0, so every board already on "can edit" keeps meaning "signed-in link holders". Widening is something an owner does per board, on purpose. That is also why this is a fourth option rather than a redefinition of the third: an owner who wants "signed-in editors only" must still be able to say it.

## The change is one line, and that is the point

```ts
const mayEdit = allowed && board.linkAccess === "edit" && board.guestEdit;
```

Everything invariant 21 names derives from that:

- the **relay** reads `socket.data.canEdit`, set from the resolver at `rooms.ts:199` and checked at `:241`;
- the **client's view mode** reads `boardAccess.canEdit`, which the server answered;
- **live promotion** already emits `ROOM_ERRORS.CAN_EDIT` / `VIEW_ONLY` and re-resolves on `applyBoardAccessChange`, so a connected guest is promoted or demoted without a reload — a path that existed and was unreachable, because a guest's `canEdit` never moved.

Two gates did **not** derive from it and had to move, and both were guarding the wrong thing:

1. **`scene.ts`'s `if (!req.user)` was unconditional on PUT.** Its own comment said it existed so an account-less visitor could not conjure a board row that needs a real owner — but as written it refused every guest write, including ones `canEdit` had just allowed. Narrowed to `if (!permission && !req.user)`, which is what the comment always claimed.
2. **`files.ts`'s POST used the signed-in-only middleware.** A guest editor would have drawn fine and had every image byte refused with a 401 — the board-with-holes failure that file already documents, arriving from the other direction. It now uses `authOrGuest` and is judged on `canEdit`, like the scene write. The `unauthorized()` on non-`rooms` scopes stays: avatars are not board content.

Attribution needed no migration. `board_scenes.updated_by` and `files.created_by` are already nullable FKs, and null is the honest value — a guest has no account to name.

## What is deliberately unchanged

**The scope.** `guestBoardId` still pins a pass to exactly one board, and `principalOf` still fails closed. A guest editor can draw on the board they were given and cannot reach another, which is the half of invariant 22 that was load-bearing. The invariant is amended to say "read-only _unless the owner widens it_", not retired.

**Guests stay anonymous.** No account is created, nothing is stored about them beyond an in-memory pass with a 12-hour TTL, and they still appear as "Guest Heron" with the guest badge. Someone who should be a durable, named collaborator should be given an invite code (ADR 0014), which is still the better answer and is still the one the panel offers first.

**The panel still says the surprising part.** The old standing note — _"people without an account can only watch, whatever the link says"_ — was unconditional and one option now makes it false. It is not deleted; it switches to _"visitors stay anonymous, and reach only this board"_, because that is what remains true and remains worth knowing at the moment of deciding.

## The risk, stated plainly

Since ADR 0012 there is no encryption behind authorization; a hole here is the whole failure. This ADR widens the one thing protecting a board, so it ships with the tests that were missing when the last hole opened. `socket/authz.test.ts` pins all six `link_access` × `guest_edit` combinations, the three ways a guest's scope must still refuse, and the four pre-existing behaviours that must not have moved. Invariant 21's lesson was that the UI kept looking correct while the guarantee was gone; a table of combinations is the cheapest thing that would have caught it.
