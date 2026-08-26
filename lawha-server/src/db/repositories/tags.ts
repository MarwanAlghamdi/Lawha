import { generateBoardId } from "../../lib/tokens.js";

import type { LawhaDatabase } from "../index.js";

export interface TagRow {
  id: string;
  owner_id: string;
  name: string;
  /** Legacy free-form CSS colour. Never written since 014; see that file. */
  color: string | null;
  /** Index into `COLLABORATOR_PALETTE`; null means no colour chosen. */
  color_index: number | null;
}

/** The row as counted, before it is shaped for the wire. */
export interface CountedTagRow extends TagRow {
  /** How many of the caller's boards carry it; drives the dashboard's counts. */
  boardCount: number;
}

export interface PublicTag {
  id: string;
  name: string;
  /** Index into `COLLABORATOR_PALETTE`; null means no colour chosen. */
  colorIndex: number | null;
  boardCount: number;
}

/**
 * The wire shape, built in one place.
 *
 * `owner_id` never leaves the server — a tag is private to the person who made
 * it, so the id of that person adds nothing a caller may act on. The legacy
 * `color` column is not emitted either: it holds a free-form CSS string from
 * before invariant 16, nothing has written it since, and shipping it would
 * give a client two colours to choose between. Migration 014 has the rest.
 */
export const toPublicTag = (row: CountedTagRow): PublicTag => ({
  id: row.id,
  name: row.name,
  colorIndex: row.color_index,
  boardCount: row.boardCount,
});

/**
 * Tags belong to a person, not to a board.
 *
 * Two people can both have a "design" tag and they are different rows, because
 * the alternative — a shared vocabulary — means one person renaming a tag
 * silently relabels everyone else's boards.
 */
export class TagsRepository {
  constructor(private readonly db: LawhaDatabase) {}

  findById(id: string): TagRow | null {
    return (
      (this.db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as
        | TagRow
        | undefined) ?? null
    );
  }

  findByName(ownerId: string, name: string): TagRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM tags WHERE owner_id = ? AND name = ?")
        .get(ownerId, name.trim()) as TagRow | undefined) ?? null
    );
  }

  listForUser(ownerId: string): CountedTagRow[] {
    return this.db
      .prepare(
        // `t.color_index`, NOT `t.color`. The legacy free-form colour column
        // is still on the table — 014 left it there on purpose — and selecting
        // it here meant every listed row carried the dead column and no
        // `color_index` at all. `toPublicTag` reads `color_index`, got
        // undefined, and JSON.stringify drops undefined keys, so the whole
        // field vanished from the response without any error anywhere.
        //
        // `COUNT(b.id)`, NOT `COUNT(bt.board_id)`. The join below is a LEFT
        // join, so a row whose board fails the predicate survives with every
        // `b.*` column NULL — and counting the *link* table's column then
        // counted it anyway, which made the `deleted_at` filter beside it do
        // nothing at all. A tag chip has been counting boards in the trash
        // since ADR 0029; counting `b.id` is what the filter was always for.
        //
        // The owner clause is the ADR 0031 half: a deleted account's boards
        // leave the grid, so they must leave the chip above it too.
        `SELECT t.id, t.name, t.color_index, COUNT(b.id) AS boardCount
           FROM tags t
           LEFT JOIN board_tags bt ON bt.tag_id = t.id
           LEFT JOIN boards b
             ON b.id = bt.board_id
            AND b.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM users o
                         WHERE o.id = b.owner_id
                           AND o.deleted_at IS NULL)
          WHERE t.owner_id = ?
          GROUP BY t.id
          ORDER BY t.name`,
      )
      .all(ownerId) as CountedTagRow[];
  }

  /** Idempotent: the dashboard creates tags by typing a name. */
  create(
    ownerId: string,
    name: string,
    colorIndex: number | null = null,
  ): TagRow {
    const existing = this.findByName(ownerId, name);
    if (existing) {
      return existing;
    }

    const row: TagRow = {
      id: generateBoardId(),
      owner_id: ownerId,
      name: name.trim(),
      // Never written since 014. Left on the row so the shape matches the
      // table; see the migration for why the column is still there.
      color: null,
      color_index: colorIndex,
    };
    this.db
      .prepare(
        `INSERT INTO tags (id, owner_id, name, color, color_index)
         VALUES (@id, @owner_id, @name, @color, @color_index)`,
      )
      .run(row);
    return row;
  }

  update(
    id: string,
    params: { name?: string; colorIndex?: number | null },
  ): TagRow | null {
    if (params.name !== undefined) {
      this.db
        .prepare("UPDATE tags SET name = ? WHERE id = ?")
        .run(params.name.trim(), id);
    }
    // `undefined` and `null` are different here: absent leaves the colour
    // alone, null clears it. A caller that means "no colour" has to say so.
    if (params.colorIndex !== undefined) {
      this.db
        .prepare("UPDATE tags SET color_index = ? WHERE id = ?")
        .run(params.colorIndex, id);
    }
    return this.findById(id);
  }

  /** board_tags cascades, so this unlabels rather than deleting any board. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  }

  // --- board ↔ tag ---------------------------------------------------------

  attach(boardId: string, tagId: string): void {
    this.db
      .prepare(
        `INSERT INTO board_tags (board_id, tag_id) VALUES (?, ?)
         ON CONFLICT (board_id, tag_id) DO NOTHING`,
      )
      .run(boardId, tagId);
  }

  detach(boardId: string, tagId: string): void {
    this.db
      .prepare("DELETE FROM board_tags WHERE board_id = ? AND tag_id = ?")
      .run(boardId, tagId);
  }

  listForBoard(boardId: string): TagRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tags t
           JOIN board_tags bt ON bt.tag_id = t.id
          WHERE bt.board_id = ?
          ORDER BY t.name`,
      )
      .all(boardId) as TagRow[];
  }

  /**
   * Tags for many boards in one query, **as one person sees them**.
   *
   * The dashboard renders every card with its tags; doing this per board is
   * the N+1 that would make a hundred-board list crawl.
   *
   * `owner_id` is the fix for a real leak. This had no owner predicate at all,
   * so on a board Alice and Bob both belong to, Bob's dashboard rendered
   * *Alice's* tag names — a private vocabulary published to everyone she
   * shared with. Tags are per person by construction (see the note at the top
   * of this file, and the same reasoning in `005_folders_and_cursor_avatar`
   * for folders), and the read has to say so or the model is decoration.
   */
  listForBoards(
    boardIds: readonly string[],
    ownerId: string,
  ): Record<string, TagRow[]> {
    const byBoard: Record<string, TagRow[]> = {};
    if (boardIds.length === 0) {
      return byBoard;
    }

    const placeholders = boardIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT bt.board_id AS boardId, t.*
           FROM board_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.board_id IN (${placeholders})
            AND t.owner_id = ?
          ORDER BY t.name`,
      )
      .all(...boardIds, ownerId) as Array<TagRow & { boardId: string }>;

    for (const { boardId, ...tag } of rows) {
      (byBoard[boardId] ??= []).push(tag as TagRow);
    }
    return byBoard;
  }

  /**
   * Replaces **one person's** tags on a board. Not the board's.
   *
   * The DELETE was unscoped: `DELETE FROM board_tags WHERE board_id = ?`. So on
   * a board Alice and Bob both belong to, Bob toggling any tag deleted every
   * row Alice had — silently, permanently, and with no way to notice until she
   * looked. Filing is per person (the `board_folders` composite key exists for
   * exactly this reason, and `005` argues it at length); this write was the one
   * place that forgot.
   *
   * Scoped by a subquery on `tags.owner_id` rather than by a column on
   * `board_tags`, because the ownership fact already lives on `tags` and
   * duplicating it would give two answers to one question.
   */
  setForBoard(
    boardId: string,
    tagIds: readonly string[],
    ownerId: string,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM board_tags
            WHERE board_id = ?
              AND tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`,
        )
        .run(boardId, ownerId);
      const insert = this.db.prepare(
        "INSERT INTO board_tags (board_id, tag_id) VALUES (?, ?)",
      );
      for (const tagId of tagIds) {
        insert.run(boardId, tagId);
      }
    })();
  }
}
