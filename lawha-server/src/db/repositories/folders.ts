import { generateFolderId } from "../../lib/tokens.js";

import type { LawhaDatabase } from "../index.js";

export interface FolderRow {
  id: string;
  owner_id: string;
  name: string;
  /** null for a root folder. Nesting arrived in migration 006. */
  parent_id: string | null;
  /** Index into the dashboard's palette, never a hex. See 006's comment. */
  color_index: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicFolder {
  id: string;
  name: string;
  parentId: string | null;
  colorIndex: number | null;
  /** How many of this person's live boards they have filed here *directly*. */
  boardCount: number;
  createdAt: number;
}

/** What `create` and `update` accept. Every field is optional on update. */
export interface FolderPatch {
  name?: string;
  parentId?: string | null;
  colorIndex?: number | null;
}

/**
 * Folders belong to a person, and so does the act of filing a board into one.
 *
 * The distinction matters more here than it does for tags. A board shared with
 * three people appears on three dashboards, and each of those people gets to
 * decide where it sits on theirs — `board_folders` is keyed on
 * (board_id, owner_id) so one member tidying up cannot move a board out of
 * somebody else's folder. `owner_id` on a filing row is the filer, which is
 * frequently not the board's owner.
 *
 * Since migration 006 folders also nest. Two things follow from that and are
 * enforced here rather than in the route, because a route is one caller and an
 * invariant with one enforcement point is an invariant waiting to be bypassed:
 * a folder may not become its own ancestor, and deleting one promotes what it
 * held up a level instead of destroying it.
 */
export class FoldersRepository {
  constructor(private readonly db: LawhaDatabase) {}

  findById(id: string): FolderRow | null {
    return (
      (this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as
        | FolderRow
        | undefined) ?? null
    );
  }

  /**
   * The folder with this name *beside* the given parent, if any.
   *
   * Replaces the old `findByName`, and the parent argument is not optional
   * padding: it is what makes this agree with the two partial unique indexes in
   * migration 006. A name check that ignored the parent would refuse a
   * perfectly legal "Drafts" inside two different projects, and — worse — the
   * `IS` comparison below is what makes it work at the root at all. SQLite's
   * `=` is never true for NULL, so `parent_id = NULL` matches nothing and every
   * root folder would look available.
   */
  findSibling(
    ownerId: string,
    parentId: string | null,
    name: string,
  ): FolderRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM folders WHERE owner_id = ? AND parent_id IS ? AND name = ?",
        )
        .get(ownerId, parentId, name.trim()) as FolderRow | undefined) ?? null
    );
  }

  listForUser(ownerId: string): PublicFolder[] {
    return this.db
      .prepare(
        // COUNT(b.id) rather than COUNT(*): the LEFT JOIN onto a live board is
        // what drops soft-deleted boards from the count, and COUNT(*) would
        // count the outer-join row that survives them.
        //
        // The access clause mirrors `BoardsRepository.listForUser` — deliberately
        // the same predicate, because these two counts are read side by side and
        // a folder chip that disagrees with the grid beneath it is a bug the user
        // cannot explain or clear. Filing survives losing access: `board_folders`
        // cascades on board, user and folder, but not on membership, so removing
        // someone from a shared board they had filed used to leave them a chip
        // reading "Active · 1" over an empty grid, permanently — the board is
        // gone from their dashboard, so they have nothing left to unfile.
        // Counting only what they can actually open fixes revocation, link-access
        // filings and any future access change in one place.
        //
        // DIRECT children only, and the dashboard knows it. Subtree counts are
        // derived on the client from the board list it already holds, so that a
        // count and the grid it sits above cannot disagree; see folderTree.ts.
        `SELECT f.id, f.name, f.parent_id AS parentId, f.color_index AS colorIndex,
                f.created_at AS createdAt,
                COUNT(b.id) AS boardCount
           FROM folders f
           LEFT JOIN board_folders bf
             ON bf.folder_id = f.id AND bf.owner_id = f.owner_id
           LEFT JOIN boards b
             ON b.id = bf.board_id
            AND b.deleted_at IS NULL
            AND (b.owner_id = f.owner_id
                 OR EXISTS (SELECT 1 FROM board_members m
                             WHERE m.board_id = b.id
                               AND m.user_id = f.owner_id))
          WHERE f.owner_id = ?
          GROUP BY f.id
          ORDER BY f.name`,
      )
      .all(ownerId) as PublicFolder[];
  }

  /**
   * Not idempotent by name, unlike `TagsRepository.create`.
   *
   * A tag is created by typing one into a chip field, where re-typing an
   * existing name obviously means "use that one". A folder is created from an
   * explicit "New folder" action, so silently handing back an existing folder
   * would look like the new one failed to appear. The route turns the unique
   * indexes into a 409 instead.
   */
  create(ownerId: string, params: FolderPatch & { name: string }): FolderRow {
    const now = Date.now();
    const row: FolderRow = {
      id: generateFolderId(),
      owner_id: ownerId,
      name: params.name.trim(),
      parent_id: params.parentId ?? null,
      color_index: params.colorIndex ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO folders (id, owner_id, name, parent_id, color_index, created_at, updated_at)
         VALUES (@id, @owner_id, @name, @parent_id, @color_index, @created_at, @updated_at)`,
      )
      .run(row);

    return row;
  }

  /**
   * Rename, recolour, or move — one statement, because `PATCH /folders/:id`
   * with a `parentId` *is* the move and there is no second endpoint to keep in
   * step with this one.
   *
   * `parentId: null` is a real instruction ("make this a root folder") and is
   * distinguished from an absent key, which means "leave the parent alone".
   * Collapsing the two would make it impossible to drag a folder out to the top
   * level, which is the one move a tree UI cannot express any other way.
   */
  update(id: string, patch: FolderPatch): FolderRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name.trim());
    }
    if (patch.parentId !== undefined) {
      sets.push("parent_id = ?");
      values.push(patch.parentId);
    }
    if (patch.colorIndex !== undefined) {
      sets.push("color_index = ?");
      values.push(patch.colorIndex);
    }

    if (sets.length === 0) {
      return this.findById(id);
    }

    sets.push("updated_at = ?");
    values.push(Date.now());

    this.db
      .prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);

    return this.findById(id);
  }

  /** Kept so the many call sites that only rename do not have to know about patches. */
  rename(id: string, name: string): FolderRow | null {
    return this.update(id, { name });
  }

  /**
   * Is `candidateId` inside the subtree rooted at `ancestorId` — including
   * being `ancestorId` itself?
   *
   * The self case is not an edge case to tidy away; it is half the point.
   * "Move Platform into Platform" and "move Platform into Platform / Sync" are
   * the same mistake, and both produce a cycle that no later query can escape:
   * the recursive CTE the sidebar walks with would spin until SQLite's depth
   * limit, on every page load, for ever. Refused at the write.
   */
  isDescendant(ancestorId: string, candidateId: string): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM folders WHERE id = ?
           UNION ALL
           SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
         )
         SELECT 1 AS hit FROM subtree WHERE id = ? LIMIT 1`,
      )
      .get(ancestorId, candidateId) as { hit: number } | undefined;

    return row !== undefined;
  }

  /**
   * A sibling name that is free, by appending " (2)", " (3)"…
   *
   * Used only by `delete`, where promoting a child up a level can collide with
   * a folder that is already there. The alternatives were both worse: refusing
   * the delete makes an unrelated name clash block an action the user has every
   * right to take, and dropping the unique index to allow the duplicate leaves
   * two folders the owner cannot tell apart — which is the exact thing the
   * index has existed to prevent since migration 005.
   */
  private freeSiblingName(
    ownerId: string,
    parentId: string | null,
    name: string,
    /**
     * A folder that does not count as an occupant, because it is about to
     * stop being one.
     *
     * This parameter is a bug fix, and the bug was reported as "when I delete
     * a folder it creates folders". `delete` has to reparent children *before*
     * dropping the row — `parent_id` has no `ON DELETE` action and foreign keys
     * are on, so SQLite refuses the delete while anything still points at it —
     * which means the doomed folder is still in the table when this check runs.
     * A child sharing its parent's name therefore collided with the parent it
     * was replacing, and came out as "aaa (2)". Deleting a folder called `aaa`
     * left you looking at a folder called `aaa (2)` that you had never made,
     * which is indistinguishable from the app inventing one.
     *
     * The check has always been reasoning about the state *after* the
     * transaction. This makes it look at that state.
     */
    ignoreId?: string,
  ): string {
    const taken = (candidate: string): boolean => {
      const clash = this.findSibling(ownerId, parentId, candidate);
      return clash !== null && clash.id !== ignoreId;
    };

    if (!taken(name)) {
      return name;
    }
    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = `${name} (${suffix})`;
      if (!taken(candidate)) {
        return candidate;
      }
    }
    // Unreachable in practice; a timestamp beats throwing on a delete.
    return `${name} (${Date.now()})`;
  }

  /**
   * Deletes a folder and **promotes what it held up one level**.
   *
   * Never deletes a board. It could not undo that if it did — the server has
   * never held a key, so a deleted scene is gone — and "delete folder" reads as
   * "delete what is in it" to almost everybody, which is why the UI says so and
   * why this method makes the UI's promise true.
   *
   * Three moves, in one transaction:
   *
   *  1. child folders reparent to this folder's own parent;
   *  2. boards filed here are refiled into that parent, or unfiled when the
   *     parent is null — which is precisely the old behaviour for a root
   *     folder, so nothing about deleting a top-level folder has changed;
   *  3. the row goes.
   *
   * Order matters. `parent_id` carries no `ON DELETE` action, so SQLite refuses
   * step 3 while any child still points here — a deliberate safety net that
   * turns a forgotten step 1 into an error rather than an orphaned subtree.
   */
  delete(id: string): void {
    this.db.transaction(() => {
      const folder = this.findById(id);
      if (!folder) {
        return;
      }
      const parentId = folder.parent_id;
      const now = Date.now();

      const children = this.db
        .prepare("SELECT * FROM folders WHERE parent_id = ?")
        .all(id) as FolderRow[];

      // Park the doomed folder's NAME before anything is promoted into its
      // place, and this is the whole fix for "deleting a folder creates
      // folders".
      //
      // The ordering is forced: `parent_id` has no `ON DELETE` action and
      // foreign keys are on, so SQLite refuses to drop this row while a child
      // still points at it — children must move first. But the partial unique
      // index on (owner, parent, name) is immediate, not deferred, so while
      // this row is still here it occupies its own name, and a child called the
      // same thing could not take it: the promotion came out as `aaa (2)`, a
      // folder the owner never made, appearing at the moment they deleted one.
      //
      // Relaxing the collision *check* alone is not enough, and was tried
      // first: the check then says "aaa is free", the UPDATE runs against a
      // table where it is not, and the delete fails with a constraint error
      // instead of a wrong name. The name has to actually be vacated.
      //
      // `~` plus the folder id, then run through the same free-name search
      // anyway — "a name nobody could have typed" is a guess, and this is one
      // UPDATE inside a transaction that is about to delete the row regardless.
      this.db
        .prepare("UPDATE folders SET name = ? WHERE id = ?")
        .run(this.freeSiblingName(folder.owner_id, parentId, `~${id}`, id), id);

      const move = this.db.prepare(
        "UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?",
      );

      for (const child of children) {
        // Resolved one at a time, and against the live table: two children
        // called "Drafts" and "Drafts (2)" promoting into a parent that already
        // has a "Drafts" must not both land on "Drafts (2)".
        move.run(
          parentId,
          this.freeSiblingName(folder.owner_id, parentId, child.name, id),
          now,
          child.id,
        );
      }

      if (parentId === null) {
        this.db
          .prepare("DELETE FROM board_folders WHERE folder_id = ?")
          .run(id);
      } else {
        // No collision is possible: `board_folders` is keyed on
        // (board_id, owner_id), so a board has at most one filing per person
        // and cannot already be sitting in the parent as well as here.
        this.db
          .prepare("UPDATE board_folders SET folder_id = ? WHERE folder_id = ?")
          .run(parentId, id);
      }

      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    })();
  }

  // --- filing, which is per person ------------------------------------------

  /**
   * Files a board for one person, replacing whatever they had it in.
   *
   * The upsert is the schema's composite key doing the work: "at most one
   * folder per board per person" is enforced by the primary key rather than by
   * a delete-then-insert that some future call site forgets to do.
   */
  file(params: { boardId: string; ownerId: string; folderId: string }): void {
    this.db
      .prepare(
        `INSERT INTO board_folders (board_id, owner_id, folder_id)
         VALUES (?, ?, ?)
         ON CONFLICT (board_id, owner_id) DO UPDATE SET folder_id = excluded.folder_id`,
      )
      .run(params.boardId, params.ownerId, params.folderId);
  }

  /** Back to the unfiled pile. Absent is the same as unfiled, so this is idempotent. */
  unfile(boardId: string, ownerId: string): void {
    this.db
      .prepare("DELETE FROM board_folders WHERE board_id = ? AND owner_id = ?")
      .run(boardId, ownerId);
  }

  folderIdFor(ownerId: string, boardId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT folder_id FROM board_folders WHERE board_id = ? AND owner_id = ?",
      )
      .get(boardId, ownerId) as { folder_id: string } | undefined;
    return row?.folder_id ?? null;
  }

  /**
   * One requester's filing of many boards, in one query.
   *
   * The dashboard renders every card with the folder *this viewer* put it in.
   * Asking per board is the N+1 that makes a hundred-board list a hundred
   * round trips to SQLite — the same reason `TagsRepository.listForBoards`
   * exists. A board absent from the map is unfiled.
   */
  folderIdsForBoards(
    ownerId: string,
    boardIds: readonly string[],
  ): Record<string, string> {
    const byBoard: Record<string, string> = {};
    if (boardIds.length === 0) {
      return byBoard;
    }

    const placeholders = boardIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT board_id AS boardId, folder_id AS folderId
           FROM board_folders
          WHERE owner_id = ? AND board_id IN (${placeholders})`,
      )
      .all(ownerId, ...boardIds) as Array<{
      boardId: string;
      folderId: string;
    }>;

    for (const { boardId, folderId } of rows) {
      byBoard[boardId] = folderId;
    }
    return byBoard;
  }
}
