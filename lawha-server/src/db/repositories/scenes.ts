import type { LawhaDatabase } from "../index.js";

export interface SceneRow {
  board_id: string;
  rev: number;
  scene_version: number;
  iv: Buffer;
  ciphertext: Buffer;
  byte_size: number;
  updated_at: number;
  updated_by: string | null;
}

export interface SceneWriteResult {
  ok: boolean;
  /** On conflict, the row the client must reconcile against. */
  current: SceneRow | null;
  rev: number | null;
}

export interface SceneWriteParams {
  boardId: string;
  /** null means "create if absent" — the client has never seen a stored scene. */
  expectedRev: number | null;
  sceneVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  updatedBy: string | null;
}

/**
 * The scene is plaintext JSON. **`ciphertext` is a column name this outlived,
 * not a description**, and `iv` has been a zero-length blob on every row since
 * ADR 0012 — the marker that says "this body is in the clear". Neither column
 * was renamed because SQLite cannot alter one without a twelve-step table
 * rebuild, and the rebuild would have bought a better word and nothing else.
 *
 * This comment used to say the opposite: *"stored as opaque ciphertext: the
 * room key never reaches the server, so it cannot reconcile."* That was true
 * until ADR 0012 removed the encryption and migration 013 dropped the key
 * tables. It is recorded rather than deleted because this is the first function
 * anyone planning encryption work reads, and it spent two ADRs telling them the
 * server could not see what it had been reading all along.
 *
 * **The conflict rule is unchanged, and its reason survives the correction.**
 * The server still does not merge — merging is per element and belongs to the
 * editor, which is where the reconciliation logic lives. So it enforces a
 * compare-and-swap on a monotonic `rev` and hands conflicts back to the client.
 * Never last-write-wins on `sceneVersion`: that value is a sum of element
 * versions, so a client holding FEWER elements can produce a LARGER one
 * (invariant 2).
 *
 * What actually protects a board is `resolveBoardPermission`, on every read and
 * every write, and nothing else (ADR 0012, invariant 21). Encryption at rest is
 * a separate and optional layer under this one — `LAWHA_DB_KEY` encrypts the
 * FILE, not the column, and this repository cannot tell the difference.
 */
export class ScenesRepository {
  constructor(private readonly db: LawhaDatabase) {}

  find(boardId: string): SceneRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM board_scenes WHERE board_id = ?")
        .get(boardId) as SceneRow | undefined) ?? null
    );
  }

  write(params: SceneWriteParams): SceneWriteResult {
    const now = Date.now();

    return this.db.transaction((): SceneWriteResult => {
      const current = this.find(params.boardId);

      if (current === null) {
        if (params.expectedRev !== null) {
          // Client expected a row that is not there — its cached rev is stale.
          return { ok: false, current: null, rev: null };
        }

        this.db
          .prepare(
            `INSERT INTO board_scenes
               (board_id, rev, scene_version, iv, ciphertext, byte_size, updated_at, updated_by)
             VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.boardId,
            params.sceneVersion,
            params.iv,
            params.ciphertext,
            params.ciphertext.byteLength,
            now,
            params.updatedBy,
          );

        this.touchBoard(params.boardId, now);
        return { ok: true, current: null, rev: 1 };
      }

      if (params.expectedRev === null || current.rev !== params.expectedRev) {
        return { ok: false, current, rev: current.rev };
      }

      const nextRev = current.rev + 1;

      this.db
        .prepare(
          `UPDATE board_scenes
              SET rev = ?, scene_version = ?, iv = ?, ciphertext = ?,
                  byte_size = ?, updated_at = ?, updated_by = ?
            WHERE board_id = ? AND rev = ?`,
        )
        .run(
          nextRev,
          params.sceneVersion,
          params.iv,
          params.ciphertext,
          params.ciphertext.byteLength,
          now,
          params.updatedBy,
          params.boardId,
          params.expectedRev,
        );

      this.touchBoard(params.boardId, now);
      return { ok: true, current: null, rev: nextRev };
    })();
  }

  private touchBoard(boardId: string, at: number): void {
    this.db
      .prepare("UPDATE boards SET updated_at = ? WHERE id = ?")
      .run(at, boardId);
  }
}
