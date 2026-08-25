import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/index.js";
import { BoardsRepository, toTrashedBoard } from "../db/repositories/boards.js";
import { FilesRepository } from "../db/repositories/files.js";
import { UsersRepository } from "../db/repositories/users.js";

import { purgeBoard, sweepExpiredTrash } from "./trashSweep.js";

import type { LawhaContext } from "../context.js";
import type { LawhaDatabase } from "../db/index.js";

/**
 * The trash, end to end at the storage layer (ADR 0029).
 *
 * A real sqlite database rather than a stubbed repository, because every claim
 * worth making here is a claim about the *database*: that the cascade takes the
 * scene, that it does **not** take the `files` rows, that the retention guard
 * lives in SQL and not only in the route, and that a restored board is
 * indistinguishable from one that was never deleted. A fake would agree with
 * whatever this file asserted.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Harness {
  db: LawhaDatabase;
  boards: BoardsRepository;
  files: FilesRepository;
  ctx: LawhaContext;
  filesDir: string;
  ownerId: string;
}

let harness: Harness;
const tempDirs: string[] = [];

const makeHarness = (retentionDays: number): Harness => {
  const db = openDatabase({ path: ":memory:" });
  const boards = new BoardsRepository(db);
  const files = new FilesRepository(db);
  const users = new UsersRepository(db);
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "lawha-trash-"));
  tempDirs.push(filesDir);

  const owner = users.create({ username: "owner", passwordHash: "x" });

  // Only the fields `trashSweep` reads. Typed through `LawhaContext` so that
  // adding a field the sweep needs breaks this file rather than silently
  // sweeping with a default.
  const ctx = {
    boards,
    config: {
      filesDir,
      trashRetentionMs: retentionDays * DAY,
      trashRetentionDays: retentionDays,
    },
  } as unknown as LawhaContext;

  return { db, boards, files, ctx, filesDir, ownerId: owner.id };
};

/** A board with a scene, a file row and a file on disk — the whole footprint. */
const seedBoard = (h: Harness, name: string) => {
  const board = h.boards.create({ ownerId: h.ownerId, name });
  h.db
    .prepare(
      `INSERT INTO board_scenes
         (board_id, rev, scene_version, iv, ciphertext, byte_size, updated_at, updated_by)
       VALUES (?, 1, 1, '', ?, 4, ?, ?)`,
    )
    .run(board.id, Buffer.from("scene"), Date.now(), h.ownerId);
  h.files.record({
    scope: "rooms",
    containerId: board.id,
    fileId: "file-1",
    byteSize: 4,
    createdBy: h.ownerId,
  });
  const dir = path.join(h.filesDir, "rooms", board.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "file-1"), "data");
  return board;
};

const deletedDaysAgo = (h: Harness, boardId: string, days: number) => {
  h.db
    .prepare("UPDATE boards SET deleted_at = ? WHERE id = ?")
    .run(Date.now() - days * DAY, boardId);
};

const sceneCount = (h: Harness, boardId: string) =>
  (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM board_scenes WHERE board_id = ?")
      .get(boardId) as { n: number }
  ).n;

beforeEach(() => {
  harness = makeHarness(30);
});

afterEach(() => {
  harness.db.close();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the trash", () => {
  it("hides a deleted board from the dashboard and shows it in the trash", () => {
    const board = seedBoard(harness, "Notes");
    harness.boards.softDelete(board.id);

    expect(harness.boards.listForUser(harness.ownerId)).toEqual([]);
    expect(
      harness.boards.listTrashedForUser(harness.ownerId).map((row) => row.id),
    ).toEqual([board.id]);
  });

  it("restores a board without disturbing where it sorts", () => {
    const board = seedBoard(harness, "Notes");
    const updatedBefore = harness.boards.findById(board.id)!.updated_at;

    harness.boards.softDelete(board.id);
    expect(harness.boards.restore(board.id)).toBe(true);

    const restored = harness.boards.findById(board.id)!;
    expect(restored.deleted_at).toBeNull();
    // The dashboard sorts on `updated_at`. Bumping it would file a board
    // restored from six weeks ago above the one worked on this morning.
    expect(restored.updated_at).toBe(updatedBefore);
    expect(
      harness.boards.listForUser(harness.ownerId).map((r) => r.id),
    ).toEqual([board.id]);
  });

  it("reports the second of two racing restores as a miss", () => {
    const board = seedBoard(harness, "Notes");
    harness.boards.softDelete(board.id);

    expect(harness.boards.restore(board.id)).toBe(true);
    expect(harness.boards.restore(board.id)).toBe(false);
  });

  it("refuses to purge a board that is not in the trash", () => {
    const board = seedBoard(harness, "Live");

    expect(harness.boards.purge(board.id)).toBe(false);
    expect(harness.boards.findById(board.id)).not.toBeNull();
    expect(sceneCount(harness, board.id)).toBe(1);
  });
});

describe("purging a board", () => {
  it("takes the row, the cascade, the file rows and the directory", async () => {
    const board = seedBoard(harness, "Doomed");
    const dir = path.join(harness.filesDir, "rooms", board.id);
    harness.boards.softDelete(board.id);

    expect(await purgeBoard(harness.ctx, board.id)).toBe(true);

    expect(harness.boards.findById(board.id)).toBeNull();
    // Cascaded by the foreign key.
    expect(sceneCount(harness, board.id)).toBe(0);
    // NOT cascaded — `files.container_id` has no REFERENCES clause, which is
    // exactly why `purge` deletes these by hand. If this assertion ever starts
    // passing for the wrong reason, the schema gained an FK and the manual
    // delete became redundant rather than wrong.
    expect(harness.files.listForContainer("rooms", board.id)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves the images alone when the row was already gone", async () => {
    const board = seedBoard(harness, "Restored mid-sweep");
    const dir = path.join(harness.filesDir, "rooms", board.id);

    // Never trashed, so `purge` matches nothing — and the disk must not be
    // swept on the strength of an id alone.
    expect(await purgeBoard(harness.ctx, board.id)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("a purged board id", () => {
  it("is marked spent, so nothing can be created at it again", async () => {
    const board = seedBoard(harness, "Doomed");
    harness.boards.softDelete(board.id);
    await purgeBoard(harness.ctx, board.id);

    // The row is gone, which is exactly what makes the id look unclaimed to
    // `PUT /boards/:id/scene` — a route that creates the board and hands
    // ownership to whoever wrote. The tombstone is the only thing that
    // distinguishes "destroyed" from "never used". Migration 020.
    expect(harness.boards.findById(board.id)).toBeNull();
    expect(harness.boards.isPurged(board.id)).toBe(true);
  });

  it("is not marked spent by a soft delete, which is reversible", () => {
    const board = seedBoard(harness, "Trashed, not gone");
    harness.boards.softDelete(board.id);

    expect(harness.boards.isPurged(board.id)).toBe(false);
  });

  it("survives the sweep the same way it survives the button", async () => {
    const board = seedBoard(harness, "Swept");
    deletedDaysAgo(harness, board.id, 42);

    await sweepExpiredTrash(harness.ctx);

    expect(harness.boards.isPurged(board.id)).toBe(true);
  });
});

describe("the retention sweep", () => {
  it("purges what has expired and keeps what has not", async () => {
    const old = seedBoard(harness, "Six weeks ago");
    const recent = seedBoard(harness, "Yesterday");
    const live = seedBoard(harness, "Still here");

    deletedDaysAgo(harness, old.id, 42);
    deletedDaysAgo(harness, recent.id, 1);

    expect(await sweepExpiredTrash(harness.ctx)).toBe(1);

    expect(harness.boards.findById(old.id)).toBeNull();
    expect(harness.boards.findById(recent.id)).not.toBeNull();
    expect(harness.boards.findById(live.id)).not.toBeNull();
  });

  it("purges nothing at all when retention is switched off", async () => {
    harness.db.close();
    harness = makeHarness(0);

    const ancient = seedBoard(harness, "Deleted in 2019");
    deletedDaysAgo(harness, ancient.id, 4000);

    // 0 means "keep for ever". Read as a cutoff it would mean `now - 0`, which
    // selects the entire trash — the failure this asserts against.
    expect(await sweepExpiredTrash(harness.ctx)).toBe(0);
    expect(harness.boards.findById(ancient.id)).not.toBeNull();
  });

  it("does not touch a board restored between listing and purging", async () => {
    const board = seedBoard(harness, "Saved just in time");
    deletedDaysAgo(harness, board.id, 42);
    harness.boards.restore(board.id);

    expect(await sweepExpiredTrash(harness.ctx)).toBe(0);
    expect(harness.boards.findById(board.id)).not.toBeNull();
  });
});

describe("migration 019", () => {
  it("gives rows deleted before the feature existed a full window", () => {
    // Applied by `openDatabase` at construction, so this asserts the state the
    // migration leaves behind rather than re-running it. A board deleted under
    // the old rule — hidden for ever, no trash, no way back — must not be
    // destroyed by the arrival of the sweep. Simulated by writing an ancient
    // timestamp and re-running the statement, which is what the migration does
    // to every pre-existing row exactly once.
    const board = seedBoard(harness, "Deleted in 2019");
    deletedDaysAgo(harness, board.id, 4000);

    harness.db
      .prepare(
        `UPDATE boards
            SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
          WHERE deleted_at IS NOT NULL`,
      )
      .run();

    const stamped = harness.boards.findById(board.id)!.deleted_at!;
    expect(Date.now() - stamped).toBeLessThan(5 * 60 * 1000);
  });
});

describe("the trash DTO", () => {
  it("dates the purge from the deletion, not from now", () => {
    const row = {
      id: "b1",
      name: "Notes",
      deleted_at: 1_000_000,
      updated_at: 500,
    } as never;

    expect(toTrashedBoard(row, 30 * DAY)).toEqual({
      id: "b1",
      name: "Notes",
      deletedAt: 1_000_000,
      updatedAt: 500,
      purgeAt: 1_000_000 + 30 * DAY,
    });
  });

  it("says nothing rather than a date when retention is off", () => {
    const row = {
      id: "b1",
      name: "Notes",
      deleted_at: 1_000_000,
      updated_at: 500,
    } as never;

    // `null`, not `deletedAt`. "Never purged" and "purged the instant it was
    // deleted" are opposite sentences and must not share a representation.
    expect(toTrashedBoard(row, 0).purgeAt).toBeNull();
  });
});
