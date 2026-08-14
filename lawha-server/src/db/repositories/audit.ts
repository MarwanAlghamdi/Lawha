import type { LawhaDatabase } from "../index.js";

/**
 * The administrative audit log. See migration 016 and ADR 0015.
 *
 * Append-only by construction: there is no update and no delete on this
 * repository, and adding one would be the point at which the log stops being
 * evidence. Nothing else in the server writes to `admin_audit`.
 */

/**
 * The vocabulary of the log.
 *
 * A closed set rather than free text, because these strings are read by the
 * panel to decide what sentence to show. A typo in a free-text action is a row
 * that renders as nothing.
 */
export type AuditAction =
  /**
   * **No longer written by anything, and deliberately still declared.**
   *
   * These were the direct `POST /admin/users/:userId/password` route, which
   * ADR 0021 replaced with the pair below. That route is gone as of Task 6 of that
   * plan — genuinely gone, answering 404, not merely unlinked from the panel.
   *
   * Deleting these two strings with it would be the wrong move, and this
   * comment is here because it is the obvious next tidy-up. ADR 0015 gives
   * `admin_audit` no delete, so every row an administrator ever produced with
   * these actions still exists and always will. Removing the strings would
   * make `recent()`'s return type a lie about rows the database still holds,
   * and send them through `LawhaAdminAudit.tsx`'s raw-name fallback — the
   * oldest and most sensitive entries in the log rendering as
   * `password.generated` instead of a sentence.
   *
   * There is nothing to keep in step: nothing writes them, so they cannot
   * drift. Grep for `"password.set"` in `src/` and the only hits are this
   * declaration and the panel's sentence for it.
   */
  | "password.set"
  | "password.generated"
  /**
   * An administrator minted a one-time password reset code
   * (`POST /admin/users/:userId/reset-code`, design spec §2 and §7).
   * `detail` records whether it locked the account and, if so, how many
   * sessions that revoked — never the code itself. The plaintext code exists
   * only in that route's response body (see `MintedResetCode` in
   * `passwordResetCodes.ts`); it is never logged, persisted, or written into
   * this row.
   */
  | "password.reset.issued"
  /**
   * The account holder redeemed a code at `/reset/:code` and set their own
   * new password. Written in Task 3, not this one — declared here now so the
   * type lands once rather than drifting across two commits. `actorLabel` is
   * the *user's own* username, not an administrator's: this is the audit
   * line design spec §7 calls "the one the product cannot currently write",
   * and it is the entire point of the feature.
   */
  | "password.reset.redeemed"
  | "sessions.revoked"
  | "admin.granted"
  | "admin.revoked"
  | "account.created"
  | "account.disabled"
  | "account.enabled"
  /**
   * A backup left the server. Recorded when the bytes start moving, not when
   * the password was accepted: a ticket that is issued and never redeemed is
   * somebody who changed their mind, and the log is a record of what happened
   * rather than of what was contemplated.
   *
   * Worth a permanent row more than most of the actions above it. This one
   * hands over every board, every password hash and every live session in a
   * single file — if any entry in this table is ever read in anger, it is this
   * one.
   */
  | "backup.downloaded";

export interface AuditEntry {
  id: number;
  at: number;
  actorUserId: string | null;
  actorLabel: string;
  viaMaster: boolean;
  action: AuditAction;
  targetUserId: string | null;
  targetLabel: string | null;
  detail: string | null;
}

interface AuditRow {
  id: number;
  at: number;
  actor_user_id: string | null;
  actor_label: string;
  via_master: number;
  action: AuditAction;
  target_user_id: string | null;
  target_label: string | null;
  detail: string | null;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  at: row.at,
  actorUserId: row.actor_user_id,
  actorLabel: row.actor_label,
  viaMaster: row.via_master === 1,
  action: row.action,
  targetUserId: row.target_user_id,
  targetLabel: row.target_label,
  detail: row.detail,
});

export class AuditRepository {
  constructor(private readonly db: LawhaDatabase) {}

  record(entry: {
    actorUserId: string | null;
    actorLabel: string;
    viaMaster: boolean;
    action: AuditAction;
    targetUserId?: string | null;
    targetLabel?: string | null;
    detail?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO admin_audit
           (at, actor_user_id, actor_label, via_master, action,
            target_user_id, target_label, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.actorUserId,
        entry.actorLabel,
        entry.viaMaster ? 1 : 0,
        entry.action,
        entry.targetUserId ?? null,
        entry.targetLabel ?? null,
        entry.detail ?? null,
      );
  }

  /**
   * Newest first, capped.
   *
   * The cap is on the query rather than on the table: the panel shows a recent
   * history, and the rows beyond it are still there for anybody with the
   * database. A log that trims itself to what a screen can show is a log that
   * loses the entry somebody eventually needs.
   */
  recent(limit = 100): AuditEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM admin_audit ORDER BY at DESC, id DESC LIMIT ?")
        .all(Math.min(Math.max(limit, 1), 500)) as AuditRow[]
    ).map(toEntry);
  }
}
