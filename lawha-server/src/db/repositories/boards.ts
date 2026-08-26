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

/**
 * A board in the trash, as its owner sees it (ADR 0029).
 *
 * A separate shape from `PublicBoard` rather than two more optional fields on
 * it. `PublicBoard` is what a *live* board looks like, and half of it is
 * meaningless here — link access, guest editing and folder filing all describe
 * how a board is reached, and nothing reaches a deleted board. Widening the
 * live shape would put six fields on every card in the dashboard that only
 * ever matter on a screen the dashboard does not show.
 *
 * `purgeAt` is computed here and sent, rather than leaving the client to add
 * thirty days to `deletedAt` itself. The retention window is a server setting
 * (`LAWHA_TRASH_RETENTION_DAYS`), the client cannot read it, and a client that
 * guessed would tell people a date the sweep does not agree with. `null` means
 * retention is switched off on this deployment and nothing will be purged —
 * which is a different sentence from "purged soon", and has to be able to say
 * so.
 */
export interface TrashedBoard {
  id: string;
  name: string;
  deletedAt: number;
  updatedAt: number;
  purgeAt: number | null;
}

export const toTrashedBoard = (
  row: BoardRow,
  retentionMs: number,
): TrashedBoard => ({
  id: row.id,
  name: row.name,
  // Non-null by construction: the only query that produces these rows filters
  // `deleted_at IS NOT NULL`. Asserted rather than defaulted to 0, because a 0
  // here would render as "deleted in 1970" and expire instantly.
  deletedAt: row.deleted_at!,
  updatedAt: row.updated_at,
  purgeAt: retentionMs > 0 ? row.deleted_at! + retentionMs : null,
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

  /**
   * The dashboard's board list.
   *
   * **The owner join is not decoration.** This query does not go through
   * `getBoardAccess`, so it learns nothing from the choke point that guards
   * every other board operation — and that is precisely the shape invariant 21
   * warns about. Without `o.deleted_at IS NULL`, a board owned by a deleted
   * account keeps appearing on its *members'* dashboards for the whole
   * retention window: a card with a thumbnail and a name that answers 403 the
   * moment it is opened, because the permission layer is correctly refusing
   * what this list is incorrectly offering. Nothing throws. It simply looks
   * like the board is broken rather than gone.
   *
   * `boards.accessByOwner.test.ts` asserts this as its own named case, apart
   * from the
   * `getBoardAccess` tests, because a fix to the resolver does not touch this
   * line and a test of the resolver would not notice.
   */
  listForUser(userId: string): BoardRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT b.* FROM boards b
         LEFT JOIN board_members m ON m.board_id = b.id
         JOIN users o ON o.id = b.owner_id
         WHERE (b.owner_id = ? OR m.user_id = ?)
           AND b.deleted_at IS NULL
           AND o.deleted_at IS NULL
         ORDER BY b.updated_at DESC`,
      )
      .all(userId, userId) as BoardRow[];
  }

  /**
   * Ids of the boards this account owns, live ones and trashed ones alike.
   *
   * Wanted by the admin delete route, which has to evict whoever is sitting in
   * those rooms right now. It includes already-trashed boards deliberately:
   * nobody should be in one, and "should be" is an assumption about the relay
   * rather than a fact from it.
   */
  idsOwnedBy(userId: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM boards WHERE owner_id = ?")
        .all(userId) as { id: string }[]
    ).map((row) => row.id);
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

  // --- trash (ADR 0029) ----------------------------------------------------

  /**
   * The caller's own trash, newest deletion first.
   *
   * **Owned, not shared.** `listForUser` above joins `board_members` because a
   * board someone shared with you belongs on your dashboard; this one does not,
   * because only the owner may delete a board (the DELETE route enforces that)
   * and therefore only the owner may undo it. Joining members here would show
   * an editor a board they cannot restore and cannot purge — a row whose every
   * button is disabled — and, worse, would announce to them that the owner
   * deleted it, which is the owner's business.
   */
  listTrashedForUser(userId: string): BoardRow[] {
    return this.db
      .prepare(
        `SELECT * FROM boards
          WHERE owner_id = ?
            AND deleted_at IS NOT NULL
          ORDER BY deleted_at DESC`,
      )
      .all(userId) as BoardRow[];
  }

  /**
   * Puts a board back.
   *
   * `updated_at` is deliberately NOT touched. The dashboard sorts on it, and
   * bumping it would file a board restored from six weeks ago at the top of
   * the list as though it were the thing you worked on most recently. What was
   * restored is the board you had, at the position it had; the restore is an
   * event about the row's *existence*, not about its contents.
   *
   * Guarded on `deleted_at IS NOT NULL` rather than on the id alone so that a
   * double-submitted restore cannot rewrite a live board's row at all — the
   * second one matches nothing and reports it.
   */
  restore(boardId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE boards SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
      )
      .run(boardId);
    return result.changes > 0;
  }

  /**
   * Ids of boards whose retention window has run out.
   *
   * Returned rather than deleted here, because the row is not the whole board:
   * its uploaded images live on disk under `filesDir/rooms/<id>` and in the
   * `files` table, and **neither is reachable by a foreign key**. `files`
   * stores `container_id` as plain TEXT with no `REFERENCES boards (id)` — see
   * `001_init.sql:98` — so the cascade that cleans up `board_scenes`,
   * `board_tags`, `board_members`, `board_folders` and `board_invites` does not
   * touch it. The caller needs the ids in order to sweep the parts SQLite will
   * not sweep for it.
   */
  findExpiredTrash(deletedBefore: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM boards
            WHERE deleted_at IS NOT NULL
              AND deleted_at < ?
            ORDER BY deleted_at ASC`,
        )
        .all(deletedBefore) as { id: string }[]
    ).map((row) => row.id);
  }

  /**
   * Removes a board and everything the database holds about it, for good.
   *
   * Two statements in one transaction, and the order matters only in that
   * neither may land without the other. `board_scenes`, `board_tags`,
   * `board_members`, `board_folders` and `board_invites` all carry
   * `ON DELETE CASCADE` from `boards (id)` and `PRAGMA foreign_keys = ON` is
   * set in `db/index.ts`, so they go with the row. The `files` rows do not —
   * that table names its container as free text — so they are deleted by hand.
   *
   * **Guarded on `deleted_at IS NOT NULL`.** A hard delete is the one operation
   * here with no undo, and this is the line that makes it impossible to reach a
   * live board with it: a caller that passes the wrong id destroys nothing
   * unless that id is already in the trash. The route checks ownership; this
   * checks that the board was ever deleted at all.
   *
   * Returns false when nothing matched, so a caller sweeping a list can tell a
   * board that was restored a moment ago from one it actually purged.
   */
  purge(boardId: string): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare("DELETE FROM boards WHERE id = ? AND deleted_at IS NOT NULL")
        .run(boardId);

      if (result.changes === 0) {
        return false;
      }

      this.db
        .prepare("DELETE FROM files WHERE scope = 'rooms' AND container_id = ?")
        .run(boardId);

      // Inside the same transaction as the DELETE, so there is no instant at
      // which the row is gone and the id is not yet marked spent. That instant
      // is exactly long enough for a queued scene write to recreate the board —
      // see migration 020 for why that route hands ownership to the writer.
      this.db
        .prepare(
          "INSERT OR REPLACE INTO purged_boards (id, purged_at) VALUES (?, ?)",
        )
        .run(boardId, Date.now());

      return true;
    })();
  }

  /**
   * Whether this id named a board that has been destroyed.
   *
   * The question `findById` cannot answer, because the answer is precisely
   * that there is no row. Every route that treats "no board here" as "so make
   * one" has to ask this first.
   */
  isPurged(boardId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM purged_boards WHERE id = ?")
        .get(boardId) !== undefined
    );
  }

  // --- authz surface -------------------------------------------------------

  /**
   * The board's access facts, as `resolveBoardPermission` needs them.
   *
   * **This is the choke point, and it is why deleting an account works at
   * all.** `createResolveBoardPermission` is built from this and nothing else,
   * and `ctx.resolveBoardPermission` / `ctx.canAccessBoard` are built from
   * that — so every place a board is guarded (the scene read and write, the
   * members and invites routes, file upload and download, duplicate, and
   * `join-room` on the relay) asks this question through here. Widening the
   * answer here widens it everywhere at once, which is the opposite of the
   * problem invariant 21 describes.
   *
   * `deletedAt` is therefore **the later of two facts**: the board's own
   * deletion, and its owner's (ADR 0031). A deleted account's boards are
   * refused to everyone, including the people it shared them with, without a
   * single row in `boards` being written — see migration 021 for why deriving
   * beats stamping.
   *
   * A LEFT JOIN, not an inner one. An inner join would return no row at all if
   * the owner were missing, which this method reports as "no such board" — and
   * "the owner row has gone" is exactly the state a half-finished purge leaves
   * behind. Answering "denied" there is right; answering "does not exist" hands
   * the id back to the routes that create a board at an unclaimed id.
   */
  getBoardAccess(boardId: string): BoardAccessRecord | null {
    const row = this.db
      .prepare(
        `SELECT b.owner_id, b.link_access, b.guest_edit, b.deleted_at,
                o.deleted_at AS owner_deleted_at, o.id AS owner_row_id
           FROM boards b
           LEFT JOIN users o ON o.id = b.owner_id
          WHERE b.id = ?`,
      )
      .get(boardId) as
      | {
          owner_id: string;
          link_access: LinkAccess;
          guest_edit: number;
          deleted_at: number | null;
          owner_deleted_at: number | null;
          owner_row_id: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    // An owner row that does not exist is treated as deleted rather than as
    // absent, for the reason in the comment above.
    const ownerDeletedAt = row.owner_row_id === null ? 0 : row.owner_deleted_at;

    return {
      ownerId: row.owner_id,
      linkAccess: row.link_access,
      guestEdit: row.guest_edit === 1,
      // The board's own deletion wins when both are set, so the number a
      // caller reads is the one that happened first — but nothing downstream
      // reads it as a date. `resolveBoardPermission` only asks whether it is
      // null, which is the whole contract.
      deletedAt: row.deleted_at ?? ownerDeletedAt,
    };
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
