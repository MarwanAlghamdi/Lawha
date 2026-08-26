import type { BoardRole } from "../../socket/authz.js";
import type { LawhaDatabase } from "../index.js";

export interface BoardMember {
  userId: string;
  username: string;
  role: BoardRole;
  addedAt: number;
}

export interface UserCandidate {
  id: string;
  username: string;
}

/**
 * Named sharing: who, other than the owner, may open a board and on what
 * terms.
 *
 * The table has existed since 001 and `addMember` had zero call sites, so
 * every board's membership was exactly one row — its owner — written by
 * `BoardsRepository.create`. Everything else was the link.
 */
export class MembersRepository {
  constructor(private readonly db: LawhaDatabase) {}

  list(boardId: string): BoardMember[] {
    return this.db
      .prepare(
        `SELECT m.user_id AS userId,
                u.username_display AS username,
                m.role AS role,
                m.added_at AS addedAt
           FROM board_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.board_id = ?
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                   m.added_at ASC`,
      )
      .all(boardId) as BoardMember[];
  }

  find(boardId: string, userId: string): BoardMember | null {
    return (
      (this.db
        .prepare(
          `SELECT m.user_id AS userId,
                  u.username_display AS username,
                  m.role AS role,
                  m.added_at AS addedAt
             FROM board_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.board_id = ? AND m.user_id = ?`,
        )
        .get(boardId, userId) as BoardMember | undefined) ?? null
    );
  }

  upsert(params: {
    boardId: string;
    userId: string;
    role: BoardRole;
    addedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO board_members (board_id, user_id, role, added_at, added_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(
        params.boardId,
        params.userId,
        params.role,
        Date.now(),
        params.addedBy,
      );
  }

  remove(boardId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM board_members WHERE board_id = ? AND user_id = ?")
      .run(boardId, userId);
  }

  /**
   * Candidates for the people picker: accounts on this server that are not
   * already on the board.
   *
   * Only id and display name leave the database. The query lives here rather
   * than in `UsersRepository` because it is a *membership* question — "who
   * could I add" — and it must never be reachable except through the board
   * route that owns it.
   */
  candidates(params: {
    boardId: string;
    query?: string;
    limit?: number;
  }): UserCandidate[] {
    const like = `%${(params.query ?? "").trim().toLowerCase()}%`;

    return this.db
      .prepare(
        `SELECT u.id AS id, u.username_display AS username
           FROM users u
          WHERE u.username_lower LIKE ?
            AND u.username_lower <> 'anonymous'
            -- Not an account somebody is about to be destroyed (ADR 0031).
            -- Sharing a board with an account that is twelve days from being
            -- swept is an invitation to a collaboration that ends without
            -- explanation. Deliberately narrower than disabled_at, which is
            -- reversible and stays offerable: a colleague on leave is still
            -- somebody you may want on the board when they come back.
            AND u.deleted_at IS NULL
            AND u.id NOT IN (SELECT user_id FROM board_members WHERE board_id = ?)
          ORDER BY u.username_lower
          LIMIT ?`,
      )
      .all(like, params.boardId, params.limit ?? 20) as UserCandidate[];
  }
}
