import type { LawhaContext } from "../context.js";
import type { UserRow } from "../db/repositories/users.js";

export const ANONYMOUS_USERNAME = "anonymous";

/**
 * The single stand-in account used while `LAWHA_REQUIRE_AUTH=false`.
 *
 * There is exactly one, shared by the HTTP and socket paths. Handing the socket
 * a per-connection id instead meant a board's own creator did not match its
 * `owner_id`, so `canAccessBoard` refused them at `join-room` — a session that
 * looked live to its host and was silently unreachable for everyone else.
 */
export const resolveAnonymousUser = (ctx: LawhaContext): UserRow =>
  ctx.users.findByUsername(ANONYMOUS_USERNAME) ??
  ctx.users.create({
    username: ANONYMOUS_USERNAME,
    // Unreachable as a credential: not a valid argon2 PHC string, so
    // verifyPassword always returns false for it.
    //
    // That claim is only true while nothing else can write this row's
    // password, and it was false twice. `RESERVED_USERNAMES` now refuses the
    // name at registration — the lookup above is BY USERNAME, so a stranger
    // who registered it simply became this account — and both ends of the
    // password-reset feature refuse this row by name (`routes/admin.ts`'s
    // mint, `routes/passwordReset.ts`'s `liveAccountFor`). Anything new that
    // can set a password has to refuse it too, or this comment goes back to
    // being wrong. Audit of 2026-08-07, finding 13(c).
    passwordHash: "!anonymous-no-login",
  });
