import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../index.js";

import { BoardsRepository } from "./boards.js";
import { FoldersRepository } from "./folders.js";
import { TagsRepository } from "./tags.js";
import { UsersRepository } from "./users.js";

import type { LawhaDatabase } from "../index.js";

/**
 * A deleted account's boards go dark — for everyone (ADR 0031).
 *
 * Two separate claims, deliberately in two separate `describe` blocks, because
 * they are enforced by two different pieces of SQL and a fix to one does not
 * touch the other:
 *
 *  - `getBoardAccess` is the choke point every permission check funnels
 *    through, so widening it widens everything at once.
 *  - `listForUser` is a raw query that never goes through it. Left alone, a
 *    member keeps seeing a card for a board the permission layer is correctly
 *    refusing — a board that looks broken rather than gone. That is invariant
 *    21's exact signature, and it is the bug this file exists to prevent.
 */

let db: LawhaDatabase;
let boards: BoardsRepository;
let users: UsersRepository;
let folders: FoldersRepository;
let tags: TagsRepository;
let owner: string;
let member: string;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  boards = new BoardsRepository(db);
  users = new UsersRepository(db);
  folders = new FoldersRepository(db);
  tags = new TagsRepository(db);
  owner = users.create({ username: "owner", passwordHash: "x" }).id;
  member = users.create({ username: "member", passwordHash: "x" }).id;
});

afterEach(() => {
  db.close();
});

const sharedBoard = (name = "Shared") => {
  const board = boards.create({ ownerId: owner, name });
  boards.addMember({
    boardId: board.id,
    userId: member,
    role: "editor",
    addedBy: owner,
  });
  return board;
};

describe("getBoardAccess", () => {
  it("reports a live board as live", () => {
    const board = sharedBoard();
    expect(boards.getBoardAccess(board.id)?.deletedAt).toBeNull();
  });

  it("refuses a board once its owner is deleted", () => {
    const board = sharedBoard();
    users.setDeleted(owner, true);

    // Non-null is the entire contract: `resolveBoardPermission` asks whether
    // this is null and nothing else, so every route that guards a board — the
    // scene read and write, members, invites, file upload and download,
    // duplicate, and `join-room` — refuses from this one change.
    expect(boards.getBoardAccess(board.id)?.deletedAt).not.toBeNull();
  });

  it("keeps refusing a board that was in its own trash first", () => {
    const board = sharedBoard();
    boards.softDelete(board.id);
    users.setDeleted(owner, true);

    expect(boards.getBoardAccess(board.id)?.deletedAt).not.toBeNull();
  });

  it("restores access when the account is restored", () => {
    const board = sharedBoard();
    users.setDeleted(owner, true);
    users.setDeleted(owner, false);

    expect(boards.getBoardAccess(board.id)?.deletedAt).toBeNull();
  });

  it("treats a board whose owner row has vanished as denied, not as absent", () => {
    const board = sharedBoard();
    // The state a half-finished purge leaves behind. `null` here would mean
    // "no such board", which is what the routes that create a board at an
    // unclaimed id are waiting to hear.
    db.prepare("DELETE FROM board_members WHERE user_id = ?").run(owner);
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM users WHERE id = ?").run(owner);

    const access = boards.getBoardAccess(board.id);
    expect(access).not.toBeNull();
    expect(access?.deletedAt).not.toBeNull();
  });
});

describe("listForUser", () => {
  it("hides a deleted owner's board from a member's dashboard", () => {
    const board = sharedBoard();
    expect(boards.listForUser(member).map((b) => b.id)).toEqual([board.id]);

    users.setDeleted(owner, true);

    // THE test. This query does not go through `getBoardAccess`, so a fix
    // that only widened the resolver would leave this green-looking card on a
    // colleague's dashboard for the whole retention window, 403ing on every
    // click.
    expect(boards.listForUser(member)).toEqual([]);
  });

  it("hides it from the deleted owner too", () => {
    sharedBoard();
    users.setDeleted(owner, true);

    expect(boards.listForUser(owner)).toEqual([]);
  });

  it("gives the board back to both when the account is restored", () => {
    const board = sharedBoard();
    users.setDeleted(owner, true);
    users.setDeleted(owner, false);

    expect(boards.listForUser(member).map((b) => b.id)).toEqual([board.id]);
    expect(boards.listForUser(owner).map((b) => b.id)).toEqual([board.id]);
  });

  it("does not resurrect a board the owner had put in their own trash", () => {
    const board = sharedBoard();
    boards.softDelete(board.id);
    users.setDeleted(owner, true);
    users.setDeleted(owner, false);

    // Restoring the account clears one timestamp. The board's own deletion is
    // a separate decision and stays where the owner left it — which is the
    // whole reason the account delete stamps nothing onto `boards`.
    expect(boards.listForUser(owner)).toEqual([]);
    expect(boards.findById(board.id)?.deleted_at).not.toBeNull();
  });
});

describe("the chips above the grid", () => {
  /**
   * The counts a member sees over their own folder rail and tag row.
   *
   * `folders.ts` says in its own comment that its access clause "mirrors
   * `BoardsRepository.listForUser` — deliberately the same predicate, because
   * these two counts are read side by side and a folder chip that disagrees
   * with the grid beneath it is a bug the user cannot explain or clear". Fixing
   * `listForUser` for a deleted owner and not these broke that mirror: the chip
   * said 1 over an empty grid, and the board was not on the dashboard so there
   * was nothing left to unfile.
   */
  const filedAndTagged = () => {
    const board = sharedBoard();
    const folder = folders.create(member, { name: "Work" });
    folders.file({ boardId: board.id, ownerId: member, folderId: folder.id });
    const tag = tags.create(member, "todo");
    tags.setForBoard(board.id, [tag.id], member);
    return board;
  };

  it("counts a live board", () => {
    filedAndTagged();
    expect(folders.listForUser(member)[0]?.boardCount).toBe(1);
    expect(tags.listForUser(member)[0]?.boardCount).toBe(1);
  });

  it("stops counting it once the owner is deleted", () => {
    filedAndTagged();
    users.setDeleted(owner, true);

    expect(boards.listForUser(member)).toEqual([]);
    expect(folders.listForUser(member)[0]?.boardCount).toBe(0);
    expect(tags.listForUser(member)[0]?.boardCount).toBe(0);
  });

  it("stops counting a board that is in its own trash", () => {
    const board = filedAndTagged();
    boards.softDelete(board.id);

    // Pre-existing, and found while fixing the above: the tag query counted
    // `bt.board_id` from the link table, so its LEFT JOIN on `boards` filtered
    // nothing at all and a trashed board kept its chip from ADR 0029 onward.
    expect(folders.listForUser(member)[0]?.boardCount).toBe(0);
    expect(tags.listForUser(member)[0]?.boardCount).toBe(0);
  });

  it("counts it again when the account comes back", () => {
    filedAndTagged();
    users.setDeleted(owner, true);
    users.setDeleted(owner, false);

    expect(folders.listForUser(member)[0]?.boardCount).toBe(1);
    expect(tags.listForUser(member)[0]?.boardCount).toBe(1);
  });
});
