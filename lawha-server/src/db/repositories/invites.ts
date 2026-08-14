import type { LawhaDatabase } from "../index.js";

/**
 * Invite codes. See migration 015 and ADR 0014.
 *
 * The role a code can grant is narrower than `BoardRole`: never `owner`. A
 * code travels by whatever channel is to hand and cannot be taken back once
 * spoken, so it must not be able to give the board away.
 */
export type InviteRole = "viewer" | "editor";

export interface InviteRow {
  code: string;
  board_id: string;
  role: InviteRole;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  revoked_at: number | null;
}

export interface InviteRedemption {
  userId: string;
  username: string;
  redeemedAt: number;
}

/**
 * Why a code will not work, or `null` if it will.
 *
 * A single field rather than three booleans, because the states are exclusive
 * and the UI has one sentence to say. Ordered by which the owner most needs
 * to know: revoking is a decision somebody made, the other two are the code
 * running out on its own.
 */
export type InviteStatus = "live" | "revoked" | "expired" | "exhausted";

export interface PublicInvite {
  code: string;
  role: InviteRole;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  status: InviteStatus;
  /** Who came in through this code. The reason redemptions are a table. */
  redeemedBy: InviteRedemption[];
}

export const inviteStatus = (
  invite: InviteRow,
  uses: number,
  now = Date.now(),
): InviteStatus => {
  if (invite.revoked_at !== null) {
    return "revoked";
  }
  if (invite.expires_at !== null && invite.expires_at <= now) {
    return "expired";
  }
  if (invite.max_uses !== null && uses >= invite.max_uses) {
    return "exhausted";
  }
  return "live";
};

export class InvitesRepository {
  constructor(private readonly db: LawhaDatabase) {}

  create(params: {
    code: string;
    boardId: string;
    role: InviteRole;
    createdBy: string;
    expiresAt: number | null;
    maxUses: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO board_invites
           (code, board_id, role, created_by, created_at, expires_at, max_uses, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        params.code,
        params.boardId,
        params.role,
        params.createdBy,
        Date.now(),
        params.expiresAt,
        params.maxUses,
      );
  }

  findByCode(code: string): InviteRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM board_invites WHERE code = ?")
        .get(code) as InviteRow | undefined) ?? null
    );
  }

  countRedemptions(code: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM board_invite_redemptions WHERE code = ?",
      )
      .get(code) as { n: number };
    return row.n;
  }

  hasRedeemed(code: string, userId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM board_invite_redemptions WHERE code = ? AND user_id = ?",
        )
        .get(code, userId) !== undefined
    );
  }

  redemptions(code: string): InviteRedemption[] {
    return this.db
      .prepare(
        `SELECT r.user_id AS userId,
                u.username_display AS username,
                r.redeemed_at AS redeemedAt
           FROM board_invite_redemptions r
           JOIN users u ON u.id = r.user_id
          WHERE r.code = ?
          ORDER BY r.redeemed_at ASC`,
      )
      .all(code) as InviteRedemption[];
  }

  /** Newest first — the code somebody just made is the one they are reading out. */
  listForBoard(boardId: string, now = Date.now()): PublicInvite[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM board_invites WHERE board_id = ? ORDER BY created_at DESC",
      )
      .all(boardId) as InviteRow[];

    return rows.map((row) => {
      const redeemedBy = this.redemptions(row.code);
      return {
        code: row.code,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        maxUses: row.max_uses,
        status: inviteStatus(row, redeemedBy.length, now),
        redeemedBy,
      };
    });
  }

  revoke(code: string): void {
    this.db
      .prepare(
        "UPDATE board_invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), code);
  }

  /**
   * Records the redemption and grants the membership as one write.
   *
   * `grantMembership` is passed in rather than the SQL being repeated here:
   * the statement that adds a member belongs to `MembersRepository`, and two
   * copies of it would drift the first time the members table changed. The
   * callback runs inside the transaction — better-sqlite3's are synchronous,
   * so this is a transaction and not a promise pretending to be one.
   *
   * Both writes or neither. Half of this is a person who has spent a
   * single-use code and cannot open the board, or a member nobody can account
   * for.
   */
  redeem(
    params: { code: string; userId: string },
    grantMembership: () => void,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO board_invite_redemptions (code, user_id, redeemed_at)
           VALUES (?, ?, ?)
           ON CONFLICT (code, user_id) DO NOTHING`,
        )
        .run(params.code, params.userId, Date.now());
      grantMembership();
    })();
  }
}
