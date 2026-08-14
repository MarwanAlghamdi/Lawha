import { generateSessionToken, hashSessionToken } from "../../lib/tokens.js";

import type { LawhaDatabase } from "../index.js";

/**
 * Sessions opened with the master password.
 *
 * These are not accounts and they are not in `sessions`. See migration 007 for
 * why the separation is structural rather than tidy: an administration session
 * must not be able to reach a board, and here it cannot, because `req.user`
 * stays undefined and every board route already refuses that.
 *
 * What one of these *can* do is exactly what `/admin` does — list accounts, set
 * a password, grant or revoke the role — and nothing else.
 */
export interface AdminSessionRow {
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

export interface CreatedAdminSession {
  /** The raw token. Only ever leaves the server inside the Set-Cookie header. */
  token: string;
  expiresAt: number;
}

export class AdminSessionsRepository {
  /**
   * Deliberately shorter than an account session, and not configurable.
   *
   * An account session is a person's ordinary working day and is now
   * effectively permanent. This one is the recovery credential's, held by
   * somebody who is by definition already locked out of something, and it
   * should not sit in a browser for a month afterwards. Twelve hours covers a
   * working day of fixing whatever went wrong and expires on its own overnight.
   */
  static readonly TTL_MS = 12 * 60 * 60 * 1000;

  constructor(private readonly db: LawhaDatabase) {}

  create(userAgent?: string): CreatedAdminSession {
    const token = generateSessionToken();
    const now = Date.now();
    const expiresAt = now + AdminSessionsRepository.TTL_MS;

    this.db
      .prepare(
        `INSERT INTO admin_sessions
           (token_hash, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashSessionToken(token), now, expiresAt, now, userAgent ?? null);

    return { token, expiresAt };
  }

  /**
   * Resolves a raw token, deleting it if expired.
   *
   * No sliding refresh, unlike `SessionsRepository.resolve`. Twelve hours from
   * when the credential was presented is the whole budget: rolling it forward
   * on activity would turn a recovery session into a permanent one for anybody
   * who left the tab open.
   */
  resolve(token: string): AdminSessionRow | null {
    const tokenHash = hashSessionToken(token);
    const session = this.db
      .prepare("SELECT * FROM admin_sessions WHERE token_hash = ?")
      .get(tokenHash) as AdminSessionRow | undefined;

    if (!session) {
      return null;
    }

    if (session.expires_at <= Date.now()) {
      this.db
        .prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
        .run(tokenHash);
      return null;
    }

    this.db
      .prepare(
        "UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?",
      )
      .run(Date.now(), tokenHash);

    return session;
  }

  revoke(token: string): void {
    this.db
      .prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
      .run(hashSessionToken(token));
  }

  /**
   * Every master session at once.
   *
   * The operator's "I think somebody else has the master password" button. It
   * is also what a master-password change should call, since nothing else ties
   * an open session back to the credential that opened it.
   */
  revokeAll(): number {
    return this.db.prepare("DELETE FROM admin_sessions").run().changes;
  }

  deleteExpired(now = Date.now()): number {
    return this.db
      .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
      .run(now).changes;
  }

  countActive(now = Date.now()): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at > ?",
        )
        .get(now) as { n: number }
    ).n;
  }
}
