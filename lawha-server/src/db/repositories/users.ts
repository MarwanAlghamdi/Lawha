import { generateUserId } from "../../lib/tokens.js";
import {
  COLLABORATOR_PALETTE_SIZE,
  normalizeUsername,
} from "../../lib/validation.js";

import type { LawhaDatabase } from "../index.js";

export interface UserRow {
  id: string;
  username_display: string;
  username_lower: string;
  password_hash: string;
  color_index: number | null;
  laser_color_index: number | null;
  is_admin: number;
  /** Filename under <filesDir>/avatars/<id>/; null means no picture. */
  avatar_id: string | null;
  /** Sniffed from the bytes on upload, never taken from the request header. */
  avatar_mime: string | null;
  /**
   * SQLite has no boolean; 0/1.
   *
   * A new row gets 1 — see `create` below and migration 009. The *column's*
   * DDL default is still 0, left over from 005 and unreachable: SQLite cannot
   * ALTER a default and rebuilding `users` to change one is not worth what it
   * risks. Read the value, never the DDL.
   */
  avatar_on_cursor: number;
  /**
   * When this account was stopped, or null while it is active.
   *
   * A timestamp rather than a flag because the question asked afterwards is
   * "when", not "whether" (migration 016). Enforced in three places — login,
   * the session middleware, and the socket handshake — because a rule enforced
   * in one layer is not enforced (invariant 21).
   */
  disabled_at: number | null;
  /**
   * When an administrator deleted this account, or null (ADR 0031).
   *
   * Separate from `disabled_at`, and both can be set. An account turned off in
   * March and deleted in April is a real sequence, and restoring the deletion
   * must not quietly turn it back on — which one status column could not have
   * expressed and one flag would have hidden.
   *
   * The account's boards go dark with it, without anything being written to
   * `boards`: `BoardsRepository.getBoardAccess` reads this column alongside the
   * board's own `deleted_at`. See migration 021 for why deriving beats
   * stamping.
   */
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Whether this row may hold a session.
 *
 * One predicate rather than three `disabled_at === null` comparisons, so the
 * three enforcement points cannot drift apart — which is the specific way a
 * rule ends up enforced in one layer and not the others.
 *
 * **Widened by ADR 0031 rather than joined by a fourth check.** A deleted
 * account is refused at login, at session resolution and at the socket
 * handshake — the same three points migration 016 established for
 * `disabled_at` — because adding a parallel `deleted_at` comparison beside
 * each of them would have recreated, deliberately, the drift this function
 * exists to prevent.
 *
 * That a deleted account cannot sign in is a decision, not a side effect. It
 * could hold a session, and the session would resolve — but
 * `resolveBoardPermission` denies on the owner's deletion before it ever
 * compares owner ids, so what they would reach is their own dashboard with
 * every board missing. A locked door explains itself; an empty room does not.
 */
export const isAccountActive = (row: UserRow): boolean =>
  row.disabled_at === null && row.deleted_at === null;

/** The user shape safe to send to a client. Note the absence of any email. */
export interface PublicUser {
  id: string;
  username: string;
  colorIndex: number | null;
  /** null means "use colorIndex"; see the 002 migration. */
  laserColorIndex: number | null;
  isAdmin: boolean;
  /**
   * Opaque, and re-minted on every upload. It is not a URL: the picture lives
   * at /api/users/<id>/avatar, which is served `immutable`, so this is the
   * version token the client appends as `?v=` to get a changed avatar past the
   * cache. null means "no picture" — render initials instead.
   */
  avatarId: string | null;
  /**
   * Whether this person wants their picture drawn as their canvas cursor.
   *
   * On unless they have turned it off (migration 009). Somebody with no
   * picture is unaffected — the identity builder needs the flag *and* a stored
   * avatar, so they keep their initials — so this being true is a standing
   * preference that takes effect the moment there is something to show.
   * Present-and-explicit rather than absent, for the same reason `avatarId` is
   * present-and-null: a client that has to infer a privacy flag from a missing
   * field will eventually infer the permissive answer.
   */
  avatarOnCursor: boolean;
  /** When the account was stopped, or null while active (migration 016). */
  disabledAt: number | null;
  /**
   * When an administrator deleted it, or null (ADR 0031).
   *
   * Present-and-null rather than absent, like `avatarId` and for the same
   * reason: the admin panel has to tell a deleted row from an active one to
   * offer Restore instead of Delete, and a client inferring that from a
   * missing field infers the wrong one.
   *
   * Only ever non-null in the administration list. Everywhere else this shape
   * describes a signed-in account, and a deleted account cannot sign in.
   */
  deletedAt: number | null;
  createdAt: number;
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  username: row.username_display,
  colorIndex: row.color_index,
  laserColorIndex: row.laser_color_index,
  isAdmin: row.is_admin === 1,
  avatarId: row.avatar_id,
  avatarOnCursor: row.avatar_on_cursor === 1,
  disabledAt: row.disabled_at,
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

export class UsersRepository {
  constructor(private readonly db: LawhaDatabase) {}

  findByUsername(username: string): UserRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM users WHERE username_lower = ?")
        .get(normalizeUsername(username)) as UserRow | undefined) ?? null
    );
  }

  findById(id: string): UserRow | null {
    return (
      (this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
        | UserRow
        | undefined) ?? null
    );
  }

  /** Every account, for the admin panel. Ordered so the list is stable. */
  listAll(): UserRow[] {
    return this.db
      .prepare("SELECT * FROM users ORDER BY username_lower")
      .all() as UserRow[];
  }

  /**
   * How many real accounts exist.
   *
   * The `anonymous` stand-in is excluded, in SQL, the same way
   * `MembersRepository.candidates` excludes it: it is machinery that
   * `LAWHA_REQUIRE_AUTH=false` materialises on the first request, not a person
   * who has signed up. Counting it would mean a server that had been booted
   * once with auth off never seeds its administrator — it would look like it
   * already had a user, and the operator would have no way in at all.
   */
  countAccounts(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE username_lower <> 'anonymous'",
        )
        .get() as { n: number }
    ).n;
  }

  /**
   * Administrators who could actually sign in.
   *
   * `countAdmins` counts the role; this counts the role *and* an account that
   * still works. The two are only different since migration 016, and the
   * difference is the whole guard: disabling the last active administrator
   * leaves a server whose administration panel nobody can open, and
   * `countAdmins` would happily report 1 for an account that cannot log in.
   */
  /**
   * Administrators who could actually sign in right now.
   *
   * The guard against demoting or disabling the last one counts this, so it
   * has to mean "could take over if you locked yourself out" rather than
   * "has the flag set". A disabled administrator is not an administrator —
   * and by the same argument, neither is a deleted one (ADR 0031).
   *
   * `deleted_at` reachable here at all is a narrow path: the delete route
   * refuses an administrator outright, so it takes demote → delete →
   * promote. It is still reachable, and a last-administrator guard satisfied
   * by an account nobody can sign into is the guard failing silently.
   */
  countActiveAdmins(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM users
            WHERE is_admin = 1
              AND disabled_at IS NULL
              AND deleted_at IS NULL`,
        )
        .get() as { n: number }
    ).n;
  }

  countAdmins(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1")
        .get() as {
        n: number;
      }
    ).n;
  }

  /**
   * The palette index a new account should get: the least-used one, ties broken
   * towards the low end.
   *
   * Leaving `color_index` NULL is what made a collaborator's cursor change
   * colour on every reconnect — NULL means "no choice on record", and the
   * client's fallback is hash(socketId), which is a fresh value each time the
   * transport comes back. Counting rather than hashing the user id also means
   * the first COLLABORATOR_PALETTE_SIZE people on a server are guaranteed to be
   * told apart, which a hash only manages by luck.
   *
   * A palette index is a default, not a claim: two people can end up the same
   * colour once the palette is exhausted, and either can change theirs.
   */
  nextColorIndex(): number {
    const counts = new Array<number>(COLLABORATOR_PALETTE_SIZE).fill(0);

    for (const { color_index: index, n } of this.db
      .prepare(
        `SELECT color_index, COUNT(*) AS n
           FROM users
          WHERE color_index IS NOT NULL
          GROUP BY color_index`,
      )
      .all() as Array<{ color_index: number; n: number }>) {
      // Ignore anything outside the palette: the column is an INTEGER with no
      // CHECK, and a row written by an older or wider build must not push the
      // answer out of range.
      if (index >= 0 && index < COLLABORATOR_PALETTE_SIZE) {
        counts[index] = n;
      }
    }

    let best = 0;
    for (let index = 1; index < COLLABORATOR_PALETTE_SIZE; index += 1) {
      if (counts[index]! < counts[best]!) {
        best = index;
      }
    }
    return best;
  }

  create(params: {
    username: string;
    passwordHash: string;
    /**
     * Omit to be assigned one. Passing an explicit `null` is different: it
     * means "no colour on record", which is the pre-Phase-3 behaviour and is
     * only what a user who has cleared their choice should get.
     */
    colorIndex?: number | null;
    isAdmin?: boolean;
  }): UserRow {
    const now = Date.now();
    const row: UserRow = {
      id: generateUserId(),
      username_display: params.username.trim(),
      username_lower: normalizeUsername(params.username),
      password_hash: params.passwordHash,
      color_index:
        params.colorIndex === undefined
          ? this.nextColorIndex()
          : params.colorIndex,
      laser_color_index: null,
      is_admin: params.isAdmin ? 1 : 0,
      avatar_id: null,
      avatar_mime: null,
      // OFF at creation: a new account is its initials until its owner says
      // otherwise. Migration 012 carries the reasoning, including the part of
      // it that is uncomfortable.
      //
      // This has now been written three times — off in 005, on in 009, off
      // again here — so the rule rather than the value: **publishing a
      // photograph of the account holder to everyone in a room is a choice a
      // default must not make on somebody's behalf.** An opt-in is one click
      // away on the account page; an opt-out that has already happened is not
      // recoverable.
      //
      // Still explicit rather than left to `DEFAULT 0`, even though the two now
      // agree. SQLite cannot alter a column default, so the DDL and this
      // literal are independent statements that have disagreed before, and a
      // reader who deletes this line because "the default already says 0"
      // would be relying on a coincidence rather than on a decision.
      avatar_on_cursor: 0,
      // Not in the INSERT below, which lets the column's own NULL stand. Named
      // here so the literal still satisfies `UserRow` and so a reader sees that
      // a new account is active rather than having to infer it from an absence.
      disabled_at: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO users
           (id, username_display, username_lower, password_hash,
            color_index, laser_color_index, is_admin,
            avatar_id, avatar_mime, avatar_on_cursor, created_at, updated_at)
         VALUES
           (@id, @username_display, @username_lower, @password_hash,
            @color_index, @laser_color_index, @is_admin,
            @avatar_id, @avatar_mime, @avatar_on_cursor, @created_at, @updated_at)`,
      )
      .run(row);

    return row;
  }

  /**
   * Points a user's row at a stored avatar, returning the id of the one it
   * replaced so the caller can unlink it.
   *
   * Returning the previous id rather than deleting here keeps the filesystem
   * out of the repository, and it is the only way the caller can clean up: the
   * id is overwritten by this statement and unrecoverable afterwards.
   */
  setAvatar(
    userId: string,
    avatar: { id: string; mime: string } | null,
  ): { previousAvatarId: string | null } {
    const previous = this.findById(userId);

    this.db
      .prepare(
        `UPDATE users
            SET avatar_id = ?, avatar_mime = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(avatar?.id ?? null, avatar?.mime ?? null, Date.now(), userId);

    return { previousAvatarId: previous?.avatar_id ?? null };
  }

  setAdmin(userId: string, isAdmin: boolean): UserRow | null {
    this.db
      .prepare("UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?")
      .run(isAdmin ? 1 : 0, Date.now(), userId);
    return this.findById(userId);
  }

  /**
   * Stops an account, or starts it again.
   *
   * Reversible by construction — nothing is deleted, so re-enabling restores
   * the account exactly, boards and all. That is the difference between this
   * and `deleteAccount`, and it is why "they have left" should reach for this
   * one: deletion takes the boards with it.
   *
   * Revoking their sessions is the caller's job, not this method's. Doing it
   * here would make disabling and re-enabling asymmetric in a way the name
   * hides, and the route that disables says so out loud instead.
   */
  setDisabled(userId: string, disabled: boolean): UserRow | null {
    this.db
      .prepare("UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?")
      .run(disabled ? Date.now() : null, Date.now(), userId);
    return this.findById(userId);
  }

  /**
   * Deletes an account, or takes it back out of the trash (ADR 0031).
   *
   * The soft half. Nothing is removed here — the row stays, its boards stay,
   * and `accountSweep` is what eventually destroys both. What changes is that
   * `isAccountActive` starts refusing the account's sessions and
   * `BoardsRepository.getBoardAccess` starts refusing its boards to everyone,
   * including the people it shared them with.
   *
   * **`disabled_at` is not touched, in either direction.** Restoring a deleted
   * account must not re-enable one that an administrator had separately turned
   * off; the two timestamps are orthogonal and "restore everything" is the
   * intuitive, wrong instinct. `lib/accountSweep.test.ts` pins it.
   *
   * Revoking sessions is the caller's job, exactly as it is for `setDisabled`
   * and for the same reason.
   */
  setDeleted(userId: string, deleted: boolean): UserRow | null {
    this.db
      .prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deleted ? Date.now() : null, Date.now(), userId);
    return this.findById(userId);
  }

  /** Accounts whose retention window has closed. See `lib/accountSweep.ts`. */
  findExpiredDeleted(deletedBefore: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM users
            WHERE deleted_at IS NOT NULL
              AND deleted_at < ?
            ORDER BY deleted_at ASC`,
        )
        .all(deletedBefore) as { id: string }[]
    ).map((row) => row.id);
  }

  updatePassword(userId: string, passwordHash: string): void {
    this.db
      .prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(passwordHash, Date.now(), userId);
  }

  updateProfile(
    userId: string,
    params: {
      username?: string;
      colorIndex?: number | null;
      laserColorIndex?: number | null;
      avatarOnCursor?: boolean;
    },
  ): UserRow | null {
    const now = Date.now();

    if (params.username !== undefined) {
      // Both columns move together: username_lower carries the uniqueness
      // index, username_display carries the casing shown on a cursor. Letting
      // them drift would make `Yasmin` and `yasmin` two different accounts.
      this.db
        .prepare(
          `UPDATE users
              SET username_display = ?, username_lower = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          params.username.trim(),
          normalizeUsername(params.username),
          now,
          userId,
        );
    }

    if (params.colorIndex !== undefined) {
      this.db
        .prepare(
          "UPDATE users SET color_index = ?, updated_at = ? WHERE id = ?",
        )
        .run(params.colorIndex, now, userId);
    }

    if (params.laserColorIndex !== undefined) {
      this.db
        .prepare(
          "UPDATE users SET laser_color_index = ?, updated_at = ? WHERE id = ?",
        )
        .run(params.laserColorIndex, now, userId);
    }

    // `!== undefined` rather than a truthiness test, because `false` is a
    // setting and not an absence: opting back out has to reach the column, and
    // `if (params.avatarOnCursor)` would make that the one edit nothing saves.
    if (params.avatarOnCursor !== undefined) {
      this.db
        .prepare(
          "UPDATE users SET avatar_on_cursor = ?, updated_at = ? WHERE id = ?",
        )
        .run(params.avatarOnCursor ? 1 : 0, now, userId);
    }

    return this.findById(userId);
  }

  /**
   * Deletes the account and everything cascading from it, returning the ids of
   * the boards that went with it so the caller can remove their file blobs.
   *
   * Two things do not cascade and are done by hand per board: the `files` rows
   * (no foreign key to `boards`) and the purged-board tombstones. Both are
   * explained at their statements below.
   *
   * The three UPDATEs are not optional. `files.created_by`,
   * `board_scenes.updated_by` and `board_members.added_by` reference users
   * without an ON DELETE clause, which SQLite treats as NO ACTION — with
   * foreign_keys=ON those rows would abort the DELETE outright. Attribution is
   * the least valuable thing here, so it is dropped rather than blocking.
   */
  deleteAccount(userId: string): { deletedBoardIds: string[] } {
    const run = this.db.transaction((id: string) => {
      const deletedBoardIds = (
        this.db
          .prepare("SELECT id FROM boards WHERE owner_id = ?")
          .all(id) as Array<{ id: string }>
      ).map((row) => row.id);

      this.db
        .prepare("UPDATE files SET created_by = NULL WHERE created_by = ?")
        .run(id);
      this.db
        .prepare(
          "UPDATE board_scenes SET updated_by = NULL WHERE updated_by = ?",
        )
        .run(id);
      this.db
        .prepare("UPDATE board_members SET added_by = NULL WHERE added_by = ?")
        .run(id);

      for (const boardId of deletedBoardIds) {
        // `files.container_id` is plain TEXT with no REFERENCES clause
        // (001_init.sql), so the cascade from `users` → `boards` →
        // `board_scenes` does not reach it. The UPDATE above proves this table
        // was in view when the method was written; only its *attribution*
        // column was, and the rows themselves have been outliving their boards
        // ever since. `BoardsRepository.purge` deletes them, and two hard-delete
        // paths disagreeing about one table is how a leak becomes permanent.
        this.db
          .prepare(
            "DELETE FROM files WHERE scope = 'rooms' AND container_id = ?",
          )
          .run(boardId);

        // The same reasoning as a purge (ADR 0029, migration 020): once the
        // board row is gone the id reads as unclaimed, and the scene write
        // route hands an unclaimed id to whoever writes to it *as its owner*.
        // A deleted account's boards are exactly the ids most likely to still
        // be sitting in somebody else's open tab.
        this.db
          .prepare(
            "INSERT OR REPLACE INTO purged_boards (id, purged_at) VALUES (?, ?)",
          )
          .run(boardId, Date.now());
      }

      this.db.prepare("DELETE FROM users WHERE id = ?").run(id);

      return { deletedBoardIds };
    });

    return run(userId);
  }
}
