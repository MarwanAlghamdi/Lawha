import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/index.js";
import { BoardsRepository } from "../db/repositories/boards.js";
import { FilesRepository } from "../db/repositories/files.js";
import { UsersRepository, isAccountActive } from "../db/repositories/users.js";

import { purgeAccount, sweepExpiredAccounts } from "./accountSweep.js";

import type { LawhaContext } from "../context.js";
import type { LawhaDatabase } from "../db/index.js";

/**
 * Deleting an account, end to end at the storage layer (ADR 0031).
 *
 * A real sqlite database rather than stubs, for the reason the board-trash
 * suite gives: every claim worth making here is a claim about the database —
 * that the cascade takes the boards, that the `files` rows go with them even
 * though no foreign key reaches them, that a tombstone is written per board,
 * and that `deleted_at` and `disabled_at` stay independent. A fake would agree
 * with whatever this file asserted.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Harness {
  db: LawhaDatabase;
  users: UsersRepository;
  boards: BoardsRepository;
  files: FilesRepository;
  ctx: LawhaContext;
  filesDir: string;
}

let h: Harness;
const tempDirs: string[] = [];

const makeHarness = (retentionDays: number): Harness => {
  const db = openDatabase({ path: ":memory:" });
  const users = new UsersRepository(db);
  const boards = new BoardsRepository(db);
  const files = new FilesRepository(db);
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "lawha-account-"));
  tempDirs.push(filesDir);

  const ctx = {
    users,
    boards,
    config: {
      filesDir,
      trashRetentionMs: retentionDays * DAY,
      trashRetentionDays: retentionDays,
    },
  } as unknown as LawhaContext;

  return { db, users, boards, files, ctx, filesDir };
};

/** An account with a board, a scene, a file row, a room dir and an avatar. */
const seedAccount = (username: string) => {
  const user = h.users.create({ username, passwordHash: "x" });
  const board = h.boards.create({ ownerId: user.id, name: `${username}'s` });

  h.db
    .prepare(
      `INSERT INTO board_scenes
         (board_id, rev, scene_version, iv, ciphertext, byte_size, updated_at, updated_by)
       VALUES (?, 1, 1, '', ?, 4, ?, ?)`,
    )
    .run(board.id, Buffer.from("scene"), Date.now(), user.id);

  h.files.record({
    scope: "rooms",
    containerId: board.id,
    fileId: "file-1",
    byteSize: 4,
    createdBy: user.id,
  });

  const roomDir = path.join(h.filesDir, "rooms", board.id);
  fs.mkdirSync(roomDir, { recursive: true });
  fs.writeFileSync(path.join(roomDir, "file-1"), "data");

  const avatarDir = path.join(h.filesDir, "avatars", user.id);
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.writeFileSync(path.join(avatarDir, "avatar.png"), "img");

  return { user, board, roomDir, avatarDir };
};

const deletedDaysAgo = (userId: string, days: number) => {
  h.db
    .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
    .run(Date.now() - days * DAY, userId);
};

beforeEach(() => {
  h = makeHarness(30);
});

afterEach(() => {
  h.db.close();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a soft-deleted account", () => {
  it("cannot hold a session, and neither can a disabled one", () => {
    const { user } = seedAccount("leaver");
    expect(isAccountActive(h.users.findById(user.id)!)).toBe(true);

    h.users.setDeleted(user.id, true);
    expect(isAccountActive(h.users.findById(user.id)!)).toBe(false);
  });

  it("keeps its username reserved", () => {
    const { user } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);

    // The uniqueness index is not partial, and `findByUsername` does not
    // filter — both deliberately. Registration answers the same 409 as for a
    // live account, so the name is held for the account that may come back and
    // nothing leaks about why. A "helpful" `AND deleted_at IS NULL` added to
    // `findByUsername` would break this silently, which is why it is pinned.
    expect(h.users.findByUsername("leaver")?.id).toBe(user.id);
  });

  it("still owns its rows — nothing is destroyed yet", () => {
    const { user, board } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);

    expect(h.users.findById(user.id)).not.toBeNull();
    expect(h.boards.findById(board.id)).not.toBeNull();
  });
});

describe("restoring an account", () => {
  it("clears deleted_at without touching disabled_at", () => {
    const { user } = seedAccount("leaver");
    h.users.setDisabled(user.id, true);
    h.users.setDeleted(user.id, true);

    h.users.setDeleted(user.id, false);

    const row = h.users.findById(user.id)!;
    expect(row.deleted_at).toBeNull();
    // The one that would pass every obvious test while silently re-admitting
    // somebody an administrator had deliberately locked out.
    expect(row.disabled_at).not.toBeNull();
    expect(isAccountActive(row)).toBe(false);
  });

  it("makes the account active again when it was only deleted", () => {
    const { user } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);
    h.users.setDeleted(user.id, false);

    expect(isAccountActive(h.users.findById(user.id)!)).toBe(true);
  });
});

describe("purging an account", () => {
  it("takes the row, its boards, the file rows, and both directories", async () => {
    const { user, board, roomDir, avatarDir } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);

    expect(await purgeAccount(h.ctx, user.id)).toBe(true);

    expect(h.users.findById(user.id)).toBeNull();
    // Cascaded from users -> boards -> board_scenes.
    expect(h.boards.findById(board.id)).toBeNull();
    // NOT cascaded: `files.container_id` has no REFERENCES clause. This passes
    // only because `purgeAccount` delegates to `UsersRepository.deleteAccount`
    // rather than issuing its own DELETE. A rewrite that "simplified" that
    // away reopens the leak, and this assertion is the guard.
    expect(h.files.listForContainer("rooms", board.id)).toEqual([]);
    expect(fs.existsSync(roomDir)).toBe(false);
    // Until this succeeds it is still a recognisable picture of a deleted
    // person.
    expect(fs.existsSync(avatarDir)).toBe(false);
  });

  it("leaves a tombstone so the board ids cannot be claimed again", async () => {
    const { user, board } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);
    await purgeAccount(h.ctx, user.id);

    expect(h.boards.isPurged(board.id)).toBe(true);
  });

  it("reports false for an account that is already gone", async () => {
    const { user } = seedAccount("leaver");
    h.users.setDeleted(user.id, true);

    expect(await purgeAccount(h.ctx, user.id)).toBe(true);
    expect(await purgeAccount(h.ctx, user.id)).toBe(false);
  });

  it("removes a board that was already in its own trash, exactly once", async () => {
    const { user, board, roomDir } = seedAccount("leaver");
    h.boards.softDelete(board.id);
    h.users.setDeleted(user.id, true);

    await purgeAccount(h.ctx, user.id);

    // The account sweep can reach a board before the board sweep does, in
    // which case `BoardsRepository.purge` never runs for it at all. Safe only
    // because `deleteAccount` does the same per-board `files` cleanup.
    expect(h.boards.findById(board.id)).toBeNull();
    expect(h.files.listForContainer("rooms", board.id)).toEqual([]);
    expect(fs.existsSync(roomDir)).toBe(false);
  });
});

describe("the account retention sweep", () => {
  it("purges what has expired and keeps what has not", async () => {
    const old = seedAccount("sixweeks");
    const recent = seedAccount("yesterday");
    const live = seedAccount("stillhere");

    deletedDaysAgo(old.user.id, 42);
    deletedDaysAgo(recent.user.id, 1);

    expect(await sweepExpiredAccounts(h.ctx)).toBe(1);

    expect(h.users.findById(old.user.id)).toBeNull();
    expect(h.users.findById(recent.user.id)).not.toBeNull();
    expect(h.users.findById(live.user.id)).not.toBeNull();
  });

  it("purges nothing at all when retention is switched off", async () => {
    h.db.close();
    h = makeHarness(0);

    const ancient = seedAccount("ancient");
    deletedDaysAgo(ancient.user.id, 4000);

    expect(await sweepExpiredAccounts(h.ctx)).toBe(0);
    expect(h.users.findById(ancient.user.id)).not.toBeNull();
  });

  it("does not list an account that was restored before the sweep ran", async () => {
    const saved = seedAccount("saved");
    deletedDaysAgo(saved.user.id, 42);
    h.users.setDeleted(saved.user.id, false);

    expect(await sweepExpiredAccounts(h.ctx)).toBe(0);
    expect(h.users.findById(saved.user.id)).not.toBeNull();
  });

  it("does not destroy an account restored AFTER the sweep listed it", async () => {
    const saved = seedAccount("saved");
    deletedDaysAgo(saved.user.id, 42);

    // The real race, and the one the test above does not reach: restoring
    // before `sweepExpiredAccounts` runs means `findExpiredDeleted` returns
    // nothing and the loop never executes, so that test passes with the guard
    // deleted entirely. Every `await` inside `purgeAccount` is a yield an
    // administrator can press Restore during, so the check has to be against
    // the row at the moment of the purge — which is what this calls directly.
    h.users.setDeleted(saved.user.id, false);

    expect(
      await purgeAccount(h.ctx, saved.user.id, { requireDeleted: true }),
    ).toBe(false);
    expect(h.users.findById(saved.user.id)).not.toBeNull();
  });

  it("still purges a live account for the caller that deletes its own", async () => {
    // `DELETE /api/auth/me` has no soft phase — the account is live when it
    // calls this — so the guard above must be opt-in rather than the default.
    const { user } = seedAccount("selfservice");

    expect(await purgeAccount(h.ctx, user.id)).toBe(true);
    expect(h.users.findById(user.id)).toBeNull();
  });

  it("leaves a merely disabled account alone for ever", async () => {
    const off = seedAccount("switchedoff");
    h.users.setDisabled(off.user.id, true);

    // Disabling is the reversible one and has no clock. Sweeping it would
    // turn "turn this off while they are on leave" into a countdown nobody
    // asked for.
    expect(await sweepExpiredAccounts(h.ctx)).toBe(0);
    expect(h.users.findById(off.user.id)).not.toBeNull();
  });
});
