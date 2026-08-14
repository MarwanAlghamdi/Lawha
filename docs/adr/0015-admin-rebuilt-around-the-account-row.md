# 0015 — `/admin` is a list of accounts, and it keeps a record

**Status:** accepted. **Supersedes the recovery half of ADR 0009**, which is about who may reach this page; that part is unchanged.

**Affects:** migration `016_admin_audit_and_disable.sql`, `db/repositories/audit.ts` (new), `db/repositories/users.ts`, `http/routes/admin.ts`, `http/routes/auth.ts`, `http/middleware/session.ts`, `lib/validation.ts`, `context.ts`; and on the client the new `lawha/admin/LawhaAdminAccounts.tsx`, `LawhaAdminAccountRow.tsx`, `LawhaAdminCreate.tsx`, `LawhaAdminSecret.tsx`, `LawhaAdminSetPassword.tsx`, `LawhaAdminAudit.tsx`, plus `lawha/pages/LawhaPasswordField.tsx` and the deletion of `lawha/account/LawhaAdminCard.tsx`.

## Context

`/admin` could do two things: set somebody's password, and toggle the administrator role. Both worked. The problems were around them.

**The shape.** `account/LawhaAdminCard.tsx` was 478 lines — over the 400 this codebase treats as the point to split — holding a list, a form, a reveal panel and a confirmation. It lived under `lawha/account/` because that is where the controls were first written, long after they stopped belonging there. Acting on somebody meant selecting their row, scrolling to a form below the list, and trusting the form was still about the person you picked, with the name appearing in two places that could disagree.

**The gaps.** Three, and each turned an ordinary request into a worse action than it needed to be:

- _"They left their laptop on a train."_ The only tool was a password reset, which also revoked their sessions. So a lost laptop cost the owner their password and a phone call.
- _"They have left the company."_ Reset their password and hope, or delete the account and take its boards with it. Neither is "this person should not sign in any more".
- _"Add the new person."_ Only by opening registration to the whole LAN for the minute it takes them to sign up, and remembering to close it again.

**The record.** Administrative actions were written to stdout and nowhere else. `routes/admin.ts` already argued at length why the role grant deserved a trace — an `is_admin` row outlives the session that wrote it, survives a password rotation, and is invisible from every screen the account's owner looks at. The trace it got is gone when the container restarts, and readable only by somebody with a shell and the patience to grep.

## Decision

**The account row is the page.** Every action lives inside the row it acts on, so there is no selection step and no second surface that can drift out of sync with it. Each destructive one confirms in place — never a native dialog (invariant 19) — with the row still visible above the question, because a generic "are you sure" gets clicked through and one that names the account and the consequence does not.

**Four capabilities are added:**

1. **Sign out everywhere**, separately from a reset. The password is untouched; they sign back in with the one they know.
2. **Turn an account off** (`users.disabled_at`). Reversible, destroys nothing, and turning it back on restores the account exactly — boards and all. Disabling revokes their sessions as well, because an account that cannot sign in but whose existing cookie still works has not been stopped, it has been inconvenienced.
3. **Create an account**, with a server-generated password by default. Works with open registration off, which is what a private deployment should be running.
4. **An audit log** (`admin_audit`), read on the page, appended to by every action above.

**Disabling is enforced in three places, and enforcing it in one is enforcing it nowhere** (invariant 21): the login route, `sessionMiddleware` where a cookie becomes `req.user`, and `createSocketAuthenticator`. One predicate — `isAccountActive` — rather than three comparisons, so the three cannot drift apart, which is the specific way a rule ends up enforced in one layer only. The login check sits _after_ the password verification, so a disabled username costs the same two hashes as any other and the route stays blind to which accounts exist.

**The master password does not override a disabled account**, and that is deliberate: "this person may not sign in" would mean very little if the administration credential could sign in as them anyway.

**The audit's actor and target are stored as labels as well as ids, with no foreign key.** That is the difference between a log and a join. `deleteAccount` removes a user row, and a cascade would then quietly delete the record of what was done to that account — exactly the record somebody would be looking for. A master-password session has no account behind it (migration 007), so `actor_user_id` is genuinely null for those and `actor_label` is the only thing that can say who; it cannot say _which person_ was holding the password, and `via_master` makes that visible on the row rather than leaving a reader to assume the named actor was a person.

**There is no route that deletes from the log.** A log with an erase button is not evidence.

## What was deliberately not built

Impersonation, master-password rotation from the UI, an administrator's browser for other people's boards, bulk actions, and account deletion. Each is a bigger power than anything above and none was asked for. Account deletion in particular already exists in the repository layer and stays out of this page on purpose — disabling is the reversible answer to every case that would have reached for it.

## Consequences

**Two bugs were found by the tests written for this, and both were silent.**

The first: `LawhaPasswordField` renders `required`, and the create form treats a blank password as "generate one". The browser's own constraint validation therefore refused to fire the form's submit event — so the feature could not work at all, and the failure mode was a button that looked live and did nothing when clicked. Fixed with an `optional` prop, defaulted off, because a field that silently stopped being required would be the worse mistake.

The second is recorded under ADR 0014 but was the same shape.

**A capability was nearly lost in the rebuild.** The first version of the row offered only a generated reset, dropping the ability to set a password the administrator chooses. The old suite caught it — `still sends a typed password as a typed password` — and it is restored as a form that replaces the row's actions. Generating stays the default, because the string's whole life is being read down a phone and the generator's alphabet drops the characters that cannot be dictated. Worth naming as a hazard of any rewrite: the tests that fail are the ones telling you what you removed.

**The last-administrator guard now counts accounts that can actually sign in**, not the role. A disabled administrator is not an administrator, and `countAdmins` would happily report 1 for an account nobody can log into. The client mirrors the same count so it does not offer a control the server will refuse (invariant 24).

**`forbidden` and `notFound` carry an optional error code**, added under ADR 0014 and used here for `ACCOUNT_DISABLED` — the sign-in screen has to say something other than "incorrect password" for an account that was turned off.

**stdout logging is kept alongside the table, not replaced by it.** The stdout line is what an operator tailing logs sees live; the row is what survives a restart. Neither is a substitute for the other.
