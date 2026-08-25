-- A purged board id is spent, and stays spent (ADR 0029).
--
-- Until the trash, no board row was ever removed, so an id that had once named
-- a board named it for ever. Hard deletion breaks that, and one route depends
-- on it more than it looks:
--
--   PUT /api/boards/:boardId/scene runs with `allowMissing: true`. When there
--   is no row for the id, `assertAccess` returns before it resolves any
--   permission at all, and the handler creates the board — **owned by whoever
--   sent the write**. That is deliberate and correct for an unclaimed id; it is
--   how a board comes into existence at all (see `routes/scene.ts`).
--
-- With no row left after a purge, "the board you just destroyed" and "an id
-- nobody has ever used" become the same thing to that route. The consequences
-- are not hypothetical: the owner's own editor tab, still open with a queued
-- save, recreates the board seconds after they emptied the trash; and anyone
-- who still holds the link recreates it *as its owner*, since the writer is
-- made owner. A soft-deleted board was safe from both because its row was still
-- there to be refused.
--
-- So the row is replaced by a marker. Deliberately just the id and a date: this
-- table must not become a second copy of the board — nothing here should
-- survive a purge that the purge was supposed to remove, and a name would.
--
-- **Not garbage-collected, and that is the intended lifetime.** The point of a
-- tombstone is that the client which still holds the id has no way to know the
-- board is gone, and it is a link in a chat message or a pinned tab, so the
-- window is open for as long as anyone keeps it. A row is sixteen bytes; a
-- deployment that purges a thousand boards spends sixteen kilobytes to close
-- the hole for ever. Expiring them would reopen it on a schedule.
--
-- No foreign key to `boards`: the whole purpose is to outlive the row.
CREATE TABLE IF NOT EXISTS purged_boards (
  id        TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL
);
