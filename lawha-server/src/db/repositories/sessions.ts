import { generateSessionToken, hashSessionToken } from "../../lib/tokens.js";

import type { LawhaDatabase } from "../index.js";

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
  /** 1 when opened with the master password rather than the account's own. */
  via_master: number;
}

export interface CreatedSession {
  /** The raw token. Only ever leaves the server inside the Set-Cookie header. */
  token: string;
  /**
   * The expiry the COOKIE may claim, which is not always the one written to the
   * row. A never-expiring session stores {@link NEVER_EXPIRES_AT} and hands
   * back a value clamped to {@link MAX_COOKIE_LIFETIME_MS}, because the only
   * consumer — `http/middleware/session.ts` — turns whatever it is given
   * straight into `Max-Age`. Read the row when you want the truth about the
   * session; read this when you are writing a header.
   */
  expiresAt: number;
}

/**
 * The far-future stand-in for "this session never expires".
 *
 * `sessions.expires_at` is `INTEGER NOT NULL` with an index on it (001_init.sql)
 * and a migration that has already run somewhere may never be edited, so
 * "never" cannot be NULL and cannot be a new nullable column. It has to be a
 * value no real clock will reach.
 *
 * 253_370_764_800_000 is 9999-01-01T00:00:00Z in milliseconds, and it is that
 * rather than the obvious alternatives for reasons that each bite somewhere:
 *
 *  - `Infinity` is not an integer and has no representation in an INTEGER
 *    column; it would have to be translated on the way in and out by every
 *    reader, which is exactly the coupling this constant exists to avoid.
 *  - `Number.MAX_SAFE_INTEGER` and `8_640_000_000_000_000` (the largest value
 *    `new Date()` accepts) both work arithmetically and both read as corruption
 *    to a human looking at a row, which is the moment this value will actually
 *    be encountered.
 *  - A round year is recognisable on sight. Somebody pulling `expires_at` out
 *    of a support session should be able to paste it into a date, see 9999, and
 *    stop looking.
 *
 * It is also comfortably below `Number.MAX_SAFE_INTEGER`, so `expires_at - now`
 * and SQLite's own comparison both stay exact.
 */
export const NEVER_EXPIRES_AT = 253_370_764_800_000;

/** Refresh when less than this remains, rather than writing on every request. */
const REFRESH_WHEN_REMAINING_MS = 24 * 60 * 60 * 1000;

/**
 * The longest lifetime worth putting in a cookie, whatever the row says.
 *
 * Chrome and Safari both cap a cookie at roughly 400 days
 * (draft-ietf-httpbis-rfc6265bis §5.5) no matter what `Max-Age` we send, so a
 * session that never expires SERVER-side still cannot hand the browser a cookie
 * that never expires. Sending the sentinel's own Max-Age — about 250 billion
 * seconds — would not buy one extra day of sign-in; it would only produce a
 * header that looks like a bug to whoever reads it next.
 *
 * What makes a session effectively permanent is the sliding refresh in
 * {@link SessionsRepository.resolve} re-issuing this cookie while the person is
 * still turning up. That is why clamping here costs nothing, and it is why that
 * refresh is now load-bearing rather than the write-avoidance optimisation it
 * started life as.
 */
const MAX_COOKIE_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * How often a never-expiring session re-issues its cookie: once per 24h of use.
 *
 * Re-issuing on *every* visit would also work, and is the simpler sentence to
 * write down, but it puts a `Set-Cookie` on every single authenticated API
 * response — bytes on every scene fetch during a collaboration session, and a
 * well-known way to stop the nginx in front of this process caching anything at
 * all. Bucketing on `last_seen_at`, which the same call is about to move
 * forward, gets the property that matters from both ends: a continuously used
 * session still crosses a bucket boundary once a day, and a sporadic one
 * re-issues on its first visit of the day. Either way the cookie is renewed
 * hundreds of times inside its 400-day cap.
 */
const COOKIE_REISSUE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `now` has crossed a re-issue boundary since `lastSeenAt`.
 *
 * Measured from `createdAt` rather than from the epoch, and the difference is
 * not cosmetic. Epoch-aligned buckets put every boundary on the same UTC
 * midnight, so every active session on the server would re-issue its cookie in
 * the same second — which is the one moment a `Set-Cookie` on every response is
 * genuinely expensive, and it lands on whatever else happens to be running then.
 * Anchoring on the row's own `created_at` staggers the boundaries across the
 * whole day for free, because sign-ins are already spread out.
 *
 * It also makes this testable at all. A freshly created session read back a
 * millisecond later is in bucket 0 both times and must NOT re-issue — an
 * assertion that was flaky against the epoch, passing all day and failing for
 * the few milliseconds a test run straddled UTC midnight. That is the shape of
 * test that gets deleted rather than diagnosed.
 */
const crossedReissueBoundary = (
  now: number,
  lastSeenAt: number,
  createdAt: number,
): boolean =>
  Math.floor((now - createdAt) / COOKIE_REISSUE_INTERVAL_MS) !==
  Math.floor((lastSeenAt - createdAt) / COOKIE_REISSUE_INTERVAL_MS);

export class SessionsRepository {
  constructor(
    private readonly db: LawhaDatabase,
    private readonly ttlMs: number,
  ) {}

  /**
   * True when this server was started with `LAWHA_SESSION_TTL_DAYS=0`.
   *
   * `<= 0` rather than `=== 0` because the config layer multiplies days by
   * 86_400_000: any value that arrives here as zero-or-less came from a setting
   * that meant "no expiry", and a repository constructed directly in a test
   * should not need to know which of the two spellings is the real one.
   */
  private get neverExpires(): boolean {
    return this.ttlMs <= 0;
  }

  /**
   * The expiry a cookie may claim for a row that expires at `expiresAt`.
   *
   * A no-op for every finite TTL anyone will configure, and the whole reason
   * `Max-Age` stays a sane number for the sentinel. Done here, in the
   * repository, rather than in `buildSessionCookie` because both call sites of
   * that builder take their value from this class — so clamping at the source
   * covers them both without either having to learn what the sentinel is.
   */
  private cookieExpiresAt(expiresAt: number, now: number): number {
    return Math.min(expiresAt, now + MAX_COOKIE_LIFETIME_MS);
  }

  create(
    userId: string,
    userAgent?: string,
    viaMaster = false,
  ): CreatedSession {
    const token = generateSessionToken();
    const now = Date.now();
    const expiresAt = this.neverExpires ? NEVER_EXPIRES_AT : now + this.ttlMs;

    this.db
      .prepare(
        `INSERT INTO sessions
           (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, via_master)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashSessionToken(token),
        userId,
        now,
        expiresAt,
        now,
        userAgent ?? null,
        viaMaster ? 1 : 0,
      );

    return { token, expiresAt: this.cookieExpiresAt(expiresAt, now) };
  }

  /**
   * Resolves a raw token to its session, deleting it if expired.
   * Returns the session plus a new expiry when the session was rolled forward.
   *
   * `refreshed` asks the caller to re-send the cookie, and on a server with no
   * expiry configured that flag is the entire mechanism rather than a nicety.
   * The row lasts for ever; the cookie cannot (see {@link
   * MAX_COOKIE_LIFETIME_MS}), so the only thing keeping somebody signed in
   * indefinitely is this method handing the cookie back out while they are
   * still visiting. Delete the refresh and every session stays alive in the
   * database while every browser quietly signs out 400 days later, with nothing
   * in between to notice — which is the shape of failure that gets reported as
   * a different bug entirely.
   *
   * The `expires_at` on the returned row is the value a cookie may claim, not
   * the raw column: `http/middleware/session.ts` feeds it straight to `Max-Age`
   * and is the only reader of it.
   */
  resolve(token: string): { session: SessionRow; refreshed: boolean } | null {
    const tokenHash = hashSessionToken(token);
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as SessionRow | undefined;

    if (!session) {
      return null;
    }

    const now = Date.now();
    const rowIsPermanent = session.expires_at >= NEVER_EXPIRES_AT;

    // The CONFIGURED lifetime wins over whatever the row was written with, and
    // it is applied the next time the session is touched rather than at boot.
    // Both directions matter and only one of them is a courtesy: an operator
    // who turns expiry off means the browser they are already signed into, and
    // an operator who turns it back ON needs the same promptness — a permanent
    // row left behind by a previous `LAWHA_SESSION_TTL_DAYS=0` would otherwise
    // be immortal for ever, which is a hole rather than a kindness.
    if (this.neverExpires) {
      const expiresAt = rowIsPermanent ? session.expires_at : NEVER_EXPIRES_AT;

      // A row being promoted gets its cookie re-issued immediately: it is
      // currently carrying whatever Max-Age the old finite TTL produced, which
      // may be hours.
      const shouldRefresh =
        !rowIsPermanent ||
        crossedReissueBoundary(now, session.last_seen_at, session.created_at);

      this.db
        .prepare(
          "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
        )
        .run(expiresAt, now, tokenHash);

      return {
        session: {
          ...session,
          expires_at: this.cookieExpiresAt(expiresAt, now),
        },
        refreshed: shouldRefresh,
      };
    }

    // Finite TTL from here down. A permanent row is brought back under it
    // before anything else looks at the clock — `expires_at <= now` is false
    // for the sentinel by construction, so without this branch the row would
    // fall through to the refresh arithmetic below, where
    // `expires_at - now < ttlMs - 24h` is also false, and the session would
    // never expire on a server that has been told to expire sessions.
    if (rowIsPermanent) {
      const expiresAt = now + this.ttlMs;
      this.db
        .prepare(
          "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
        )
        .run(expiresAt, now, tokenHash);
      return {
        session: {
          ...session,
          expires_at: this.cookieExpiresAt(expiresAt, now),
        },
        refreshed: true,
      };
    }

    if (session.expires_at <= now) {
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(tokenHash);
      return null;
    }

    const shouldRefresh =
      session.expires_at - now < this.ttlMs - REFRESH_WHEN_REMAINING_MS;

    if (shouldRefresh) {
      const expiresAt = now + this.ttlMs;
      this.db
        .prepare(
          "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
        )
        .run(expiresAt, now, tokenHash);
      return {
        session: {
          ...session,
          expires_at: this.cookieExpiresAt(expiresAt, now),
        },
        refreshed: true,
      };
    }

    this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(now, tokenHash);

    return {
      session: {
        ...session,
        expires_at: this.cookieExpiresAt(session.expires_at, now),
      },
      refreshed: false,
    };
  }

  revoke(token: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashSessionToken(token));
  }

  /** Used after a password change: every other device must re-authenticate. */
  revokeAllExcept(userId: string, keepToken: string): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(userId, hashSessionToken(keepToken));
    return result.changes;
  }

  revokeAllForUser(userId: string): number {
    return this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId)
      .changes;
  }

  /**
   * The hourly sweep in `index.ts`, and nothing else, calls this.
   *
   * `expires_at < NEVER_EXPIRES_AT` is not redundant with `expires_at <= ?`,
   * and leaving it out is the bug this guard exists to prevent. The clock this
   * runs on is the machine's, supplied by the default argument and never
   * validated: a box whose date has jumped forward — a VM restored from a
   * snapshot, a container with no RTC, a test that passes its own `now` — would
   * satisfy `expires_at <= now` for the sentinel too and delete every permanent
   * session on the server in one tick. The only symptom would be everybody
   * being signed out at once, with no error anywhere and a sweep that reports
   * success. Excluding the sentinel in SQL makes "never" mean never no matter
   * what the clock says.
   */
  deleteExpired(now = Date.now()): number {
    return this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ? AND expires_at < ?")
      .run(now, NEVER_EXPIRES_AT).changes;
  }
}
