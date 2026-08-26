# 0031 — An administrator can delete an account, and it waits thirty days

**Status:** accepted. **Reads on [0029](0029-deleted-boards-wait.md)** (the board trash it mirrors) and **[0015](0015-admin-rebuilt-around-the-account-row.md)**.

**Affects:** `lawha-server/src/db/migrations/021_deleted_accounts.sql`; `lawha-server/src/db/repositories/{users,boards,audit}.ts`; `lawha-server/src/lib/accountSweep.ts` (new); `lawha-server/src/lib/validation.ts`; `lawha-server/src/http/routes/{admin,auth}.ts`; `lawha-server/src/index.ts`; `excalidraw-app/lawha/auth/authApi.ts`; `excalidraw-app/lawha/admin/{LawhaAdminAccountRow,LawhaAdminAccounts}.tsx`; `excalidraw-app/lawha/styles/lawha-primitives.scss`.

## Context

The panel could turn an account off and it could not remove one. Turning off is the right answer most of the time — it stops the account dead, keeps every board, and is undone by pressing the button again — but it is not an answer to "this person has left and their account should not exist". The only route that deleted anything was `DELETE /api/auth/me`, which requires the account holder's own password, so an administrator's options were to ask a departed colleague to log in, or to open the database.

## Decision

**An administrator can delete a non-admin account. It goes into a thirty-day window, and then it and its boards are destroyed.**

Five decisions inside that, each of which had an obvious wrong answer.

### 1. The boards are destroyed, and there is no ownership transfer

`boards.owner_id` is written at creation and never reassigned — there is no transfer anywhere in this codebase, and this decision does not add one. Deleting an account therefore takes every board it owns, including boards it had shared with other people, and those boards disappear from their collaborators' dashboards with no explanation.

That is a real cost and it was chosen deliberately. On the deployment this was written against, two of the eight board-owning accounts own a board shared with somebody else. The mitigation is not a transfer mechanism, it is the window: for thirty days a mistake is one click from being undone, and the confirmation states the consequence in the sentence.

### 2. The account is soft-deleted, so "destroyed" is deferred

The cascade from `users(id)` is what destroys the boards, and a soft delete does not cascade. So the two decisions compose: `deleted_at` is stamped, everything goes dark, and thirty days later one hard `DELETE FROM users` does what the cascade always did.

`LAWHA_TRASH_RETENTION_DAYS` is shared with the board trash rather than duplicated. "A deleted thing is kept for N days" is one rule, and two knobs that almost always hold the same number is two chances to set one of them wrong.

### 3. The boards are not stamped — the owner is asked

During the window the account's boards have to be unreachable by everyone, or the deletion means nothing. Two ways to do that:

- **stamp `boards.deleted_at` on every owned board.** Then a restore has to put back only the boards the account had _not_ already deleted itself, which means remembering which those were — a second source of truth that has to agree with the first for ever.
- **derive it.** `BoardsRepository.getBoardAccess` reads the owner's `deleted_at` beside the board's own. A restore is one `UPDATE users`.

Deriving won, and it is safe because of a fact about this codebase rather than a general principle: `getBoardAccess` is the **only** thing `createResolveBoardPermission` is built from, and `ctx.resolveBoardPermission` / `ctx.canAccessBoard` are the only things every guarded board operation asks. The scene read and write, members, invites, file upload and download, duplicate and `join-room` all funnel through one function, so widening it widens them together — the exact opposite of the problem invariant 21 names.

**One query does not funnel through it, and finding that was the point of the exercise.** `BoardsRepository.listForUser` is raw SQL that builds the dashboard. Left alone, a member keeps seeing a card for a board the permission layer is correctly refusing: a thumbnail, a name, and a 403 on every click, for thirty days. Nothing throws; it looks like the board is broken rather than gone. It is fixed by hand with an owner join, and `boards.accessByOwner.test.ts` asserts it as its own named case — removing the join fails exactly those two tests and leaves the `getBoardAccess` tests green, which is what proves they are different code paths rather than one.

### 4. A deleted account cannot sign in

`isAccountActive` is widened rather than joined by a fourth check, so the three enforcement points migration 016 established — login, session resolution, the socket handshake — cover this too.

It could have gone the other way: let them sign in, since the account still exists. But `resolveBoardPermission` denies on the owner's deletion _before_ it compares owner ids, so what they would reach is their own dashboard with every board missing. A locked door explains itself; an empty room does not.

### 5. The confirmation is a typed username, checked on the server

Every other action on this row is undone by pressing the button beside it. This one starts a clock and then takes an account and its boards for good, and the mistake it has to defend against is not an unattended browser — the admin session already answered that — it is pressing the button on the row next to the one you meant.

So the confirm strip asks for the account's username, and **the route compares it too**. The panel's own check unlocks a button and enforces nothing; a client is not a place to put a guarantee (invariant 21). Both sides normalise case: rejecting a correct answer typed in the wrong case teaches people to distrust the box.

### 6. The purge asks the row, not the listing that produced it

`purgeAccount` takes `requireDeleted`, and the sweep is the caller that passes it. Every `await` inside that function is a yield — the socket eviction, the fan-out, a recursive `fs.rm` — and an administrator pressing Restore during any of them gets a 200 and a panel saying the account is back, moments before the loop reaches it and destroys the account and every board it owns.

It is opt-in rather than the default because `DELETE /api/auth/me` purges a **live** account: there is no soft phase on the path where somebody deletes their own account with their own password.

This was found in review, and so was the reason it survived the first round of tests: the test that claimed to cover it restored the account _before_ calling the sweep, so `findExpiredDeleted` returned nothing and the loop never ran. It passed with the guard deleted entirely. The replacement calls `purgeAccount` directly on a restored account, which is the moment that actually matters, and fails without the guard.

## Consequences

- **`DELETE /api/auth/me` stays immediate**, and now shares `purgeAccount` with the sweep. The asymmetry is the point: reversibility here protects against an administrator's mistake about somebody who is not present to object, while a person deleting their own account with their own password is making an informed choice — and holding their username for a month would be the worse outcome for them.
- **An administrator must be demoted before deletion.** Not a last-administrator count: counting would make an irreversible action safe or unsafe depending on a number nobody was looking at.
- **`countActiveAdmins` learned about `deleted_at`.** A deleted administrator is reachable by demote → delete → promote, and one satisfying the last-administrator guard is that guard failing silently. Promoting a deleted account is now refused outright.
- **A username stays reserved for the whole window.** The unique index is not partial and `findByUsername` does not filter, both left deliberately alone; registration answers the same 409 it always did, so nothing leaks about why. A future "helpful" `AND deleted_at IS NULL` on that lookup would break the reservation silently, which is why a test pins it.
- **The audit row outlives its subject.** `admin_audit` has no foreign key on `target_user_id` on purpose (migration 016). Thirty days after `account.deleted`, that row and its denormalised `target_label` are the only remaining record that the account existed or who removed it.
- **The `anonymous` stand-in is refused by name.** Under `LAWHA_REQUIRE_AUTH=false` that row owns every board on the server, and `GET /admin/users` filters it out — so deleting it would take the deployment dark with no row left in the panel to restore. `anonymousUser.ts` states refusing it as a standing obligation on anything new that can damage a row.
- **Five existing admin routes now refuse a deleted account.** Reset code, lock-and-reset, sign-out, turn-off and the role toggle all assumed an account somebody could still sign into. Minting a reset code for a deleted one handed the administrator a link that `passwordReset.ts` refuses at redemption — a control that fails only in the other person's hands.
- **Folder and tag chips learned the same predicate as the grid.** `folders.ts` says in its own comment that its access clause mirrors `listForUser` "because these two counts are read side by side and a folder chip that disagrees with the grid beneath it is a bug the user cannot explain or clear". Fixing `listForUser` and not those two broke that mirror. Fixing the tag query surfaced a separate pre-existing bug: it counted `bt.board_id` from the link table, so its `LEFT JOIN` on `boards` filtered nothing and a chip had been counting trashed boards since ADR 0029.
- **Collaborators are told nothing.** A board owned by a deleted account vanishes from their dashboard and is destroyed thirty days later, and neither moment produces a signal they could read. This was decided explicitly rather than arrived at: giving them a countdown would mean the derive exposing a reason rather than a boolean, and a "deleted" account's boards staying half-visible.

## Alternatives rejected

**Transfer the boards to the acting administrator.** The kindest option — deleting an account would never destroy a board — and rejected because a bare master-password session has no account to transfer to, and because inheriting a departed colleague's scratch boards makes the panel's operator the owner of everything anyone ever abandoned.

**Refuse to delete an account that owns shared boards.** Safe, and it leaves an administrator with no in-app way to finish the job they came to do.

**A JSX adapter between the row and the container.** `onAction={(action, target) => void onAction(action, target)}` existed to discard a promise, and a two-parameter function is assignable to a three-parameter type — so it type-checked and threw the typed username away on every delete, sending `{"username":""}`. Neither `tsc` nor any test found it; driving the real panel did. The prop returns `void | Promise<void>` now and the container's handler is passed directly, so there is no adapter left to drop anything.

**Passing `user.username` from the accounts container.** The first implementation did, and it made the server's check unreachable: the id and the name were read off the same object, so they could not disagree and every request the panel could generate was accepted. The typed value is threaded up through `onAction` instead, so the string the server compares is the string a human typed.

**A separate Trash screen for accounts, like the board trash.** Board trash is a frequent workflow and earns a screen. Deleted accounts are rare; they surface as a row in the list they were already in, with a chip and one remaining action.
