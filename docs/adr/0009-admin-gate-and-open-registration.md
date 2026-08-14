# 0009 — `/admin` announces itself, and the front door stays open

- **Status:** accepted
- **Supersedes, in part:** the concealment argument recorded in `RequireAdmin`, `routes/router.tsx` and `LawhaAdminRoute`. It had no ADR of its own — it lived in comments and in one test, which is part of why reversing it needed one.

## Context

Two decisions are recorded here because they were made together and one caused the other.

### The lockdown that answered the wrong question

Asked to make it so that "no one can see anything unless they used their account login when admin or with a master key", the previous change set `LAWHA_ALLOW_OPEN_REGISTRATION=false` and generated a `LAWHA_MASTER_PASSWORD`. Closing registration was the wrong half:

- It bought nothing against the accounts that already existed — six of them, all still signing in with their own passwords. Registration controls who may join, not who may see.
- It broke `e2e/auth.setup.ts`, which registers the suite's shared account through `POST /api/auth/register`; that route began answering 403, and the whole visual suite went with it.
- It stopped anybody joining the server without an operator, on a product whose entire premise is a small team on a private network.

The gate was wanted at `/admin`. That is where it now is.

### The redirect that read as a bug

`/admin` was unlisted: nothing links to it, it is absent from `robots.txt`, and `RequireAdmin` had three branches designed so that guessing the address told you nothing.

- Signed out → the ordinary `/signin` card, rendered in place, word for word. A test compared the two screens' text and asserted equality, and additionally that neither matched `/admin/i`.
- Signed in, not an administrator → `<Navigate to="/" replace />`. Not a 403, because a 403 confirms the address exists, while a redirect is indistinguishable from mistyping a URL.

The reasoning was sound and the property was real. It was also indistinguishable from something else: a page that silently sends you somewhere else is what a broken page looks like. It was reported as one — _"when i go to https://.../admin it takes me to main dashboard page"_ — by the person who administers the server, holding the master password, on their own machine.

An access control nobody can tell apart from a fault has a cost that does not appear in any threat model.

## Decision

**1. Registration stays open.** `LAWHA_ALLOW_OPEN_REGISTRATION` returns to its default of `true`. If this deployment ever wants to be invite-only that is a separate, deliberate decision, and closing it is one line — but it is not a substitute for a gate on the administration page, and it was being used as one.

**2. `/admin` may be reached by anyone, and tells them what it is.** `RequireAdmin` collapses to two branches: the session is still loading, or it is not through — in which case it renders `LawhaAdminGate` **at `/admin`**, with no navigation. The gate names the page, says whose session is currently signed in if any, and offers both credentials the server will accept: an administrator's account, or the master password.

**3. The predicate is declared once.** `canReachAdmin(user, viaMaster)` lives beside the gate and is used by the guard and by the gate. Two copies would agree until one was edited, and the survivor would keep the screen looking correct — the shape of failure invariant 21 exists for.

## What deliberately did not change

- **The enforcement.** `requireAdmin` in `lawha-server/src/http/routes/admin.ts` refuses every route behind this on `!req.user.isAdmin && req.viaMaster !== true`, regardless of what the client renders. The client guard was always a courtesy. What this ADR spends is obscurity, and obscurity was never the control.
- **The master password is a login credential, not a page unlock.** The session it opens belongs to a real account, carries `viaMaster`, says so on the panel behind the gate, and is written to the server log. _(Amended below: the gate's master segment no longer asks for a **username** — the server resolves the account instead. The constraint that survives is that somebody is signed in as, not that the person typing has to name them.)_
- **`/admin` is still unlinked**, and still absent from `robots.txt` — a `Disallow` line is a directory of the things you did not want found. Reaching it remains an act rather than an accident, which is what moving the recovery controls off the account panel was for in the first place.

## Consequences

- A URL-guesser now learns that `https://<host>/admin` is the administration page. Accepted.
- The gate advertises the master password where one is configured, so more ordinary typos will reach `MASTER_ATTEMPT_LIMIT` — ten verifications per quarter hour, global, in memory. A spent budget closes only the skeleton key: everyone still signs in with their own password, and the operator still has `LAWHA_ADMIN_USERNAME` and `yarn --cwd lawha-server reset-password`. Watch it; the durable fix (a counter in SQLite) is a schema change and belongs in its own decision.
- Two tests were **deleted rather than adjusted**, and the reason is written into `LawhaAdminRoute.test.tsx` where a future reader will find it: "shows the ordinary sign-in screen, word for word" and "redirects a signed-in non-admin to `/`". Both pinned exactly the property this ADR gives up. Weakening them until they passed would have left the file claiming a guarantee the code no longer offers.
- `LawhaSignInScreen` has one caller again. Its `redirectTo: string | null` and the `null` branch existed solely so `/admin` could render it without changing the URL; both are gone rather than left as a path nothing takes.

---

## Amendment — the master password on `/admin`, and `/` for a stranger

Three changes, made together after using the gate above.

**1. `/admin`'s master segment takes the password and nothing else.** The original said a username was required and that a bare password box "would promise a door that does not exist". That was true of `POST /auth/login`, and it was the wrong conclusion: the constraint is that _somebody_ must be signed in as, not that the person typing has to know who. `POST /auth/master` now takes `{password}` alone and resolves the account server-side — `UsersRepository.findPrimaryAdmin`: `LAWHA_ADMIN_USERNAME` when that account exists and holds the role, otherwise the oldest administrator.

It is a **new route**, not a widened `loginSchema`. `/login` is tuned so that neither its cost nor its status code discloses which usernames exist, and every branch of it exists to keep that true; folding an optional username into it would run a second, differently shaped path through the same equalising logic, and the first person to edit either would break the other. This route has no username to leak, and it spends the same global `MASTER_ATTEMPT_LIMIT` bucket, so adding a second door did not add a second budget.

**What was rejected:** a session with `user = NULL` — a true page unlock. It is simpler and it destroys the audit trail permanently. `/admin` writes a line naming the actor on every role grant; under that design "root granted admin to yasmin" becomes unattributable for every use of the credential, and two people who both know the master password can never be told apart afterwards.

**2. The master-password checkbox is gone from `/signin`.** People sign in there with their own password. `POST /auth/login` still accepts `master: true` beside a username — that is "sign in _as_ somebody to reproduce their problem" — but it is no longer offered, permanently, to everybody who only ever wanted to type their own credentials.

**3. `/` sends a signed-out visitor to `/signin`.** It used to render the canvas, on the reasoning that a working canvas with a Sign in button beats a redirect. In practice it is where `Untitled-2026-08-03` comes from: work started by somebody with nowhere to save it.

Two things still open without an account and neither goes through `LandingRoute`: `#room=`/`#json=`/`#url=` links, which carry their scene in the fragment, and **`/b/<id>`**, where the board's own `link_access` decides. A share link that demanded registration would not be a share link. `LAWHA_REQUIRE_AUTH=false` deployments are unaffected — there the server issues the shared anonymous identity rather than a 401, so the session is `authenticated` and the redirect is never reached.

**4. A refused access check is now believed.** `resolveBoardAccess` mapped every non-2xx to `FULL_BOARD_ACCESS` — right for a network blip, wrong for a 401, which is the server answering rather than failing to. Believing `canEdit: true` after a 401 meant `Collab.saveCollabRoomToBackend`'s guard waved every save through, so an accountless visitor produced an endless stream of `PUT /api/boards/<id>/scene 401` and a "Could not save the board" dialog every few seconds, on a board they had never been allowed to write. 401 and 403 now resolve to `NO_BOARD_ACCESS`; everything else keeps the optimistic fallback, because a blip must still not lock somebody out of their own board. Invariant 24.
