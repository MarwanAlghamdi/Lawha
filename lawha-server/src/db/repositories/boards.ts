import { generateBoardId } from "../../lib/tokens.js";

import type {
  BoardAccessRecord,
  BoardRole,
  LinkAccess,
} from "../../socket/authz.js";
import type { LawhaDatabase } from "../index.js";

export interface BoardRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  link_access: LinkAccess;
  guest_edit: number;
  thumbnail_path: string | null;
  thumbnail_updated_at: number | null;
  is_archived: number;
  deleted_at: number | null;
}

export interface PublicBoard {
  id: string;
  name: string;
  ownerId: string;
  linkAccess: LinkAccess;
  /** Whether `linkAccess: "edit"` reaches visitors with no account (ADR 0024). */
  guestEdit: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  isArchived: boolean;
  /**
   * Which of the *requesting user's* folders this board sits in, or null when
   * they have not filed it.
   *
   * Not derivable from the row, and that is the point: filing lives in
   * `board_folders` keyed on (board_id, owner_id), so the same board answers
   * this question differently for each of the people it is shared with. See
   * migration 005.
   */
  folderId: string | null;
}

/**
 * The board as one person sees it.
 *
 * `folderId` is a required second argument rather than an optional one on
 * purpose. It cannot be read off the row — it is a fact about the viewer — and
 * a default of `null` would let a new call site quietly report every board as
 * unfiled, which looks exactly like a dashboard that has lost its folders.
 */
export const toPublicBoard = (
  row: BoardRow,
  folderId: string | null,
): PublicBoard => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  linkAccess: row.link_access,
  guestEdit: row.guest_edit === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastOpenedAt: row.last_opened_at,
  isArchived: row.is_archived === 1,
  folderId,
});

export class BoardsRepository {
  constructor(private readonly db: LawhaDatabase) {}

  findById(id: string): BoardRow | null {
    return (
      (this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as
        | BoardRow
        | undefined) ?? null
    );
  }

  create(params: {
    ownerId: string;
    name?: string;
    id?: string;
    linkAccess?: LinkAccess;
  }): BoardRow {
    const now = Date.now();
    const id = params.id ?? generateBoardId();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO boards
             (id, name, owner_id, created_at, updated_at, last_opened_at, link_access)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.name ?? "Untitled",
          params.ownerId,
          now,
          now,
          now,
          params.linkAccess ?? "none",
        );

      this.db
        .prepare(
          `INSERT INTO board_members (board_id, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        )
        .run(id, params.ownerId, now, params.ownerId);
    })();

    return this.findById(id)!;
  }

  listForUser(userId: string): BoardRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT b.* FROM boards b
         LEFT JOIN board_members m ON m.board_id = b.id
         WHERE (b.owner_id = ? OR m.user_id = ?)
           AND b.deleted_at IS NULL
         ORDER BY b.updated_at DESC`,
      )
      .all(userId, userId) as BoardRow[];
  }

  rename(boardId: string, name: string): void {
    this.db
      .prepare("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, Date.now(), boardId);
  }

  /**
   * The owner picks one option; it is stored as two columns (ADR 0024).
   *
   * `guestEdit` is written on every call rather than only when it is true, so
   * moving from "can edit, including visitors" back to "can view" cannot leave
   * the wider flag behind on a board whose link no longer justifies it.
   */
  setLinkAccess(
    boardId: string,
    linkAccess: LinkAccess,
    guestEdit = false,
  ): void {
    this.db
      .prepare(
        "UPDATE boards SET link_access = ?, guest_edit = ?, updated_at = ? WHERE id = ?",
      )
      .run(linkAccess, guestEdit ? 1 : 0, Date.now(), boardId);
  }

  touch(boardId: string, at = Date.now()): void {
    this.db
      .prepare(
        "UPDATE boards SET updated_at = ?, last_opened_at = ? WHERE id = ?",
      )
      .run(at, at, boardId);
  }

  /**
   * Copies a board, its scene blob, and its tags.
   *
   * The ciphertext is copied **verbatim, keeping the source board's key**. The
   * server cannot re-encrypt — it has never held a key — so a copy under a new
   * key is not something it could produce. The client keeps both ids pointing
   * at the same key in its keystore, which is also what makes the copy openable
   * from the same share link material.
   */
  duplicate(params: {
    sourceId: string;
    ownerId: string;
    name: string;
  }): BoardRow {
    const now = Date.now();
    const id = generateBoardId();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO boards
             (id, name, owner_id, created_at, updated_at, last_opened_at, link_access)
           VALUES (?, ?, ?, ?, ?, ?, 'none')`,
        )
        .run(id, params.name, params.ownerId, now, now, now);

      this.db
        .prepare(
          `INSERT INTO board_members (board_id, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        )
        .run(id, params.ownerId, now, params.ownerId);

      // rev restarts at 1: the copy has its own compare-and-swap history, and
      // inheriting the source's rev would let a client holding a stale cached
      // rev for the source write straight over the copy.
      this.db
        .prepare(
          `INSERT INTO board_scenes
             (board_id, rev, scene_version, iv, ciphertext, byte_size, updated_at, updated_by)
           SELECT ?, 1, scene_version, iv, ciphertext, byte_size, ?, ?
             FROM board_scenes WHERE board_id = ?`,
        )
        .run(id, now, params.ownerId, params.sourceId);

      this.db
        .prepare(
          `INSERT INTO board_tags (board_id, tag_id)
           SELECT ?, tag_id FROM board_tags WHERE board_id = ?`,
        )
        .run(id, params.sourceId);

      // `board_folders` is deliberately NOT copied. Copying every row would
      // file the new board into strangers' folders — the rows belong to each
      // person who filed the source, not to the board — and copying only the
      // duplicator's row would still be a guess. A copy starts unfiled, the
      // same way it starts unshared.
    })();

    return this.findById(id)!;
  }

  softDelete(boardId: string): void {
    this.db
      .prepare("UPDATE boards SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), boardId);
  }

  // --- authz surface -------------------------------------------------------

  getBoardAccess(boardId: string): BoardAccessRecord | null {
    const row = this.db
      .prepare(
        "SELECT owner_id, link_access, guest_edit, deleted_at FROM boards WHERE id = ?",
      )
      .get(boardId) as
      | {
          owner_id: string;
          link_access: LinkAccess;
          guest_edit: number;
          deleted_at: number | null;
        }
      | undefined;

    return row
      ? {
          ownerId: row.owner_id,
          linkAccess: row.link_access,
          guestEdit: row.guest_edit === 1,
          deletedAt: row.deleted_at,
        }
      : null;
  }

  getMemberRole(boardId: string, userId: string): BoardRole | null {
    const row = this.db
      .prepare(
        "SELECT role FROM board_members WHERE board_id = ? AND user_id = ?",
      )
      .get(boardId, userId) as { role: BoardRole } | undefined;
    return row?.role ?? null;
  }

  listMembers(
    boardId: string,
  ): { userId: string; username: string; role: BoardRole }[] {
    return this.db
      .prepare(
        `SELECT m.user_id AS userId, u.username_display AS username, m.role AS role
           FROM board_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.board_id = ?
          ORDER BY m.added_at ASC`,
      )
      .all(boardId) as { userId: string; username: string; role: BoardRole }[];
  }

  addMember(params: {
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
}
