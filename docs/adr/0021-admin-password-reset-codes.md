# 0021 — An administrator hands over a link, not a password

**Status:** accepted **Date:** 2026-08-07, amended 2026-08-12 (see the bottom) **Removes** `POST /api/admin/users/:id/password`, which was added by ADR 0015 and now answers 404.

**Affects:** migration `017_password_reset_codes.sql`, `db/repositories/passwordResetCodes.ts` (new), `http/routes/passwordReset.ts` (new), `http/routes/admin.ts`, `lib/validation.ts`, `lib/anonymousUser.ts`, `http/app.ts`; and on the client the new `lawha/reset/ResetRoute.tsx`, `data/passwordReset.ts`, `lawha/admin/LawhaAdminResetCode.tsx`, plus `lawha/admin/LawhaAdminAccountRow.tsx`, `routes/router.tsx`, `lawha/auth/authApi.ts` and the deletion of `lawha/admin/LawhaAdminSetPassword.tsx`.

## The gap

`/admin` could set any account's password. It worked, it revoked their sessions, and the panel even generated the password so the administrator was not choosing it — and every one of those improvements was beside the point.

**An administrator who sets a password knows it.** From that moment nothing that account does can be honestly attributed to the person who owns it: not a board they deleted, not an edit somebody disagrees with, not a sign-in at three in the morning. The audit log names the account, and the account is no longer evidence of anybody. `admin.ts` had already written this argument down for the master password —

> "A master-password session has nobody behind it… the administration password did it, and cannot say which person was holding the password."

— and then applied it nowhere near the button that had the same property every single time it was pressed. The generated-password variant had the flaw more quietly, not less: the administrator did not choose the value, but it was still on their screen.

The routine case is what makes this worth changing. It is not abuse; it is a colleague forgetting their password on a Tuesday. That path ran through the one control that left an administrator holding a working credential, every time, with nothing distinguishing it from the other thing.

## Decision

**The administrator mints a one-time code and hands over a link. The account holder chooses the password, and nobody else ever sees it.**

`/admin`'s account row loses **Set password** and gains two buttons that mint the same kind of code and differ by one flag:

| Button | Effect on the account | For |
| --- | --- | --- |
| **Make a reset code** | Nothing at all. Password and sessions keep working until the link is used. | "I forgot it." |
| **Lock and reset** | Password overwritten with a sentinel, every session revoked, every live board connection dropped — immediately. | "It leaked", or somebody left. |

The panel shows `/reset/<code>` once. The person opens it, sets a password, and is signed in; every other session they had ends at that moment.

**The direct route is removed, not unlinked.** Leaving the handler behind a hidden UI would preserve the exact capability being removed, and a break-glass one `curl` away becomes the normal path again the first week somebody is in a hurry. `POST /api/admin/users/:id/password` answers 404, and there are tests that fail if a working handler is put back.

**Two things deliberately survive.** The master password, which exists for the case where every administrator is locked out — it is already flagged on the session it creates, logged, and announced in that session's UI, so it is not the silent capability this ADR is about. And `lawha-server`'s `reset-password` CLI, which needs shell access to the host: a different trust level, reached a different way, and the last resort when the UI is unreachable.

## What this buys, precisely — and what it does not

**It does not make administrator impersonation impossible.** An administrator can still mint a code, intercept it, and redeem it themselves. Nothing here prevents that and nothing here claims to.

What changes is that doing so becomes a **deliberate, logged, multi-step act instead of the ordinary flow**. Before, the routine path left an administrator holding a working credential every time; there was no shape of behaviour that distinguished the honest use from the other one, because they were the same action. Now the routine path leaves them holding nothing, and abuse requires stepping off it.

The audit log is where stepping off it shows up, and the pair of rows is the evidence — neither one alone:

- `password.reset.issued` names the administrator, the account, and whether it locked them out.
- `password.reset.redeemed` names **the account holder** as the actor. That is the line the product could not previously write, and it is the point of the whole change.

Since 2026-08-12 the redemption row also records, in its existing free-text `detail`, whether the request arrived carrying a signed-in session — "redeemed from a session signed in as `<username>`". A person recovering their own account normally arrives with no session; an administrator redeeming a code they intercepted arrives as themselves. That one fact was in the request all along and was being discarded on a stated belief that it could not exist. It is the signal that separates the two cases, and it is the closest this design gets to detection. It is not proof: an administrator who signs out first, or uses a private window, writes the honest row.

Claiming the stronger property would be false. This is the improvement, stated at its real size.

## The code is the whole credential, and everything follows from that

There is no session on the redemption route and no username beside the code — somebody locked out cannot authenticate, so there is nothing to ask them for. Five consequences, each of which is a decision rather than a detail:

**Entropy.** 32 random bytes, `lib/tokens.ts`, the same as a session token — not the short human-readable shape `board_invites` uses, because this is read off a screen and pasted, never typed from memory. 43 base64url characters.

**Stored hashed.** `code_hash` is `sha256(code)`, the same protection `sessions.token_hash` has given a session token since `001_init.sql`. A leaked copy of this table in the clear would otherwise have handed over every live reset link outright, no cracking required. The plaintext exists in `create()`'s return value, in the response body, and nowhere else — not in the audit row, not in the stdout line, not in the table.

**Its own rate limit, a literal.** Ten attempts per address per fifteen minutes, across both verbs. It is deliberately **not** `config.loginLimitPerIp`: this deployment sets `LAWHA_LOGIN_LIMIT_PER_IP=0`, and `0` means _off_ rather than "allow nothing", so a recovery route that inherited that setting would have had no limit at all and nothing about it would have looked wrong. There is no global counter beside the per-address one — ten wrong guesses from anywhere on the LAN must not be able to close the recovery path at the moment somebody is locked out, and 256 bits is not brute-forceable online at any rate a global counter could shave.

**One hour, and single use.** Long enough to hand over in person or on Teams, short enough that an intercepted code is usually already dead. `expires_at` is `NOT NULL`, unlike `board_invites` where NULL means never: an invite that never expires is a decision an owner makes about their own board, and a password reset that never expires is a liability sitting in a table waiting to be found.

**No route guard on `/reset/:code`, and that absence is load-bearing.** Not `RequireSession` — whoever is there cannot sign in, so a gate would bounce them to the one screen they cannot get past and the recovery path would be gone. Not `RedirectIfSignedIn` either, which is the less obvious half: an "I forgot it" reset locks nothing, so the person may still be signed in on that browser, and bouncing them to `/` would make the code they were just handed unusable with nothing on screen saying why. `router.tsx` carries the prose and `ResetRoute.test.tsx` now asserts the element is bare, so "adding the guard for consistency" with the two `/join` entries above it fails a test instead of quietly deleting the only way back into a locked account.

## Recall: one live code per account, because the plaintext is gone

The first version of this feature had no way to cancel a code at all. `revoke()` existed with zero callers, so `revoked_at` could never be set by anything in the product, and the whole apparatus defending that state — the `AND revoked_at IS NULL` guard, the server's `REVOKED` refusal, the client's refusal copy — was unreachable. `markRedeemed` carried a comment reasoning carefully about a race against a capability that did not exist.

That was a spec-level omission rather than an implementer's slip: the design gave `revoke` no producing action, and the build brief explicitly required that two mints leave two live codes. It made the feature a **regression** against the route it replaced. An administrator who leaked a directly-set password contained it by setting the password again; an administrator who pasted a reset link into the wrong chat could do nothing whatsoever, and "Lock and reset" — the button whose confirmation says "they cannot sign in until they use the code" — swept the sessions and left the leaked code working.

**Reversed 2026-08-12.** Every mint calls `revokeAllLiveForUser(userId)` before `create()`, unconditionally, so at most one code per account is ever live. Three things about the shape:

- **Account-keyed, not code-keyed.** `revoke(code)` cannot be the recall, because the recall is needed exactly when the administrator no longer has the code — it went into the wrong chat window. The plaintext exists once, on its way to one recipient.
- **Unconditional, not inside the `lock` branch.** The leak an administrator is reacting to is at least as likely to have been a `lock: false` code.
- **Before `create()`.** After it, the same `WHERE` would revoke the code the request is about to hand back.

So **the recall procedure is to mint again**, and that is the whole of it. It also closes a second defect for free: `markRedeemed`'s compare-and-swap is keyed on `code_hash`, so two _different_ codes for one account never contended and both could be spent, leaving one of the two redeemers with a dead cookie and a 200.

The honest procedure before this existed was _disable the account, wait out the hour, re-enable, mint afresh_ — reachable, since a code for a disabled account is refused at both ends, and documented nowhere.

## Locking reuses the unreachable-hash trick, and that was verified first

A locked account gets `LOCKED_PASSWORD_HASH` — the same not-a-valid-argon2-PHC-string sentinel `anonymousUser.ts` stores — rather than a new `password_reset_required` column. That is only safe because `verifyPassword` reads a malformed stored hash as **"wrong password" rather than throwing**. If it threw, a locked account would turn sign-in into a 500, which is a worse failure than the one being fixed. The design said to verify that before building on it; it was verified, and there is a test.

**`anonymous` is refused at both ends.** The reserved stand-in account, used while `LAWHA_REQUIRE_AUTH=false`, stores that same sentinel and `anonymousUser.ts` described it as "unreachable as a credential". This route falsified that outright: a code minted against the row let anybody choose a real password for it, and `POST /auth/login` then accepted it — on an account that owns every board made in that configuration and that `GET /admin/users` filters out, so no administrator could see or disable what they had just given away. The mint route now 404s it (the same answer a made-up id gets) and `liveAccountFor` refuses it on both verbs, so GET and POST agree (invariant 24) and the repository-level path is covered too (invariant 21). `anonymous` also joined `RESERVED_USERNAMES`, since any stranger could register it.

## The link is a URL, so it inherited three problems the URL already had

**It needed a route per address, not the administrator's own.** The first version built `${window.location.origin}/reset/${code}`, on the reasoning that the address which works for the administrator is the one most likely to work for the recipient. That reasoning is exactly what `shareOrigins.ts` exists to delete, and it is worse here than anywhere else it appeared: **whoever generates the link decides the recipient's route**, and the recipient of this particular link is by definition somebody who cannot sign in — so a LAN URL handed to somebody off-network fails closed for the one person who has no way to report it. `/admin` now renders one row per published origin, from the same `buildShareTargets` the share panel uses.

The trade in that is conceded rather than argued away: the public row hands a live password-reset credential to somebody through a third party that terminates TLS, and an hour is long enough for that third party to redeem it first. The same concession is already made one panel over for ADR 0014's invite codes. What decides it is that withholding the route is not neutral — the alternative was the LAN URL that fails closed for exactly the wrong person. The public row is labelled, never first, and carries the liveness dot beside it.

**A server that is down is not a broken link.** `ResetRoute` rendered its `default` branch — advice about a truncated link — for a rejected fetch, an nginx HTML 502 and an empty 504 alike, telling a locked-out person their only way back in was malformed. The client now mints `RESET_UNREACHABLE` for a refusal that never reached the server, tells them to try again, and offers a button that re-runs the request as a state change rather than a reload (a reload is the one move the rate-limited case cannot afford).

**The plaintext code was landing in nginx's access log**, three lines per redemption, `Cache-Control: no-store` on the response notwithstanding — the reverse proxy in this same repository was keeping the copy the route said nothing between it and the browser may keep. Suppressed at log time for `/reset/<code>`, `/api/auth/reset/<code>` and, since they have the identical shape, `/join/<code>` and the two `/api/invites/<code>` forms. At log time via a `map` and `access_log … if=`, not `access_log off` in a `location` — the SPA routes end at `try_files … /index.html`, and that fallback is an internal redirect which re-runs location matching, so a `location`-level `access_log off` three lines above it is a **measured silent no-op**. Hygiene rather than a takeover path: reading that log on this host needs root or the docker socket, which is a _higher_ bar than reading `~/lawha-data/lawha.db` at 0644.

## Consequences

- **One new table** (`password_reset_codes`, migration 017), modelled on `board_invites`. `created_by` is nullable on purpose — a master-password session has no `req.user`, and `NOT NULL` would crash the flow in precisely the recovery scenario it exists for. `ON DELETE CASCADE` on `user_id`, so deleting an account takes its outstanding codes with it.
- **One route removed and three added.** `POST /api/admin/users/:id/reset-code`, `GET /api/auth/reset/:code` (enough to render the page — the username, whether the mint locked the account, and when the code dies; not the account's id, its role, or anything else `toPublicUser` would have handed over for free), `POST /api/auth/reset/:code`.
- **A second router on `/api/auth`.** `routes/auth.ts` is 700 lines in which every branch of `/login` exists to keep that route blind to which usernames exist; an unrelated handler in there is one somebody has to reason about against that constraint for ever.
- **The audit table gains two actions**, and ADR 0015 gave it no delete.
- **`/admin`'s reset panel is the only surface in the product that shows a value it can never show again.** Pressing Done without taking the link produces no error, no log line and no way back, so it gets a question: one press asks, the next goes through. A speed bump, not a lock, because a lock on the wrong side of a mistake is worse than the mistake. With several routes on screen the question is genuinely a question — `ShareTargets` owns its own copy buttons and reports a failure but never a success, so the panel cannot know whether the link was taken and does not claim to. Asserting a falsehood about the one string that cannot be shown again would be worse than asking.
- **A "Lock and reset" now disconnects live boards**, not only sessions. Deleting session rows does nothing to a socket that is already up, since authentication is a handshake middleware that runs once — so before 2026-08-12 the thief with the stolen laptop kept relaying every element to the room, and peers persisted those edits. This is the CRITICAL finding of that day's audit and it is fixed for all four revocation paths, not just this one.
- **Out of scope, deliberately:** email delivery of anything (there is none — invariant 9), self-service "forgot password" without an administrator, and changing the master password mechanism.

## Amendment, 2026-08-12 — what the audit changed

Written into the sections above rather than appended as a list, because in each case the original reasoning is what makes the change legible. Collected here so the diff is findable:

- **Recall exists** (`revokeAllLiveForUser`, every mint). The build brief's "two mints leave two live codes" is reversed, and the test that pinned it was rewritten against the new rule rather than deleted.
- **The redemption row records whether the redeemer carried a session.** The comment justifying recording nothing asserted that `req.user` was "undefined by construction" on that route; `sessionMiddleware` is mounted app-wide with no path guard, and the abusive redemption was reproduced arriving with the administrator's account on it.
- **`anonymous` is refused** at the mint route, at `liveAccountFor`, and in `RESERVED_USERNAMES`. One visible status change came with it: renaming yourself to `anonymous` via `PATCH /api/auth/me` now answers 400 "That username is reserved." where it answered 409 "That username is taken."
- **Revocation reaches the relay** (`notifyUserSessionsRevoked`), from all four in-process call sites. Not from `cli/reset-password.ts`, which is a separate process with no socket server — wiring it there would have been a silent no-op that looked like coverage.
- **The reset link is offered per route**, the reset page distinguishes "the server is down" from "your link is broken", and the code no longer reaches nginx's access log.
