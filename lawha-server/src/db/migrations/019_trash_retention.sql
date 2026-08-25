-- A deleted board waits thirty days before it is really gone (ADR 0029).
--
-- `boards.deleted_at` has existed since 001_init.sql. Until now it only ever
-- meant "hidden": every read filtered `deleted_at IS NULL`, nothing listed the
-- hidden rows, and nothing ever removed them. The column was a tombstone with
-- no gravedigger and no way back — recovering a board meant an operator
-- opening the database by hand and clearing the timestamp, which is exactly
-- what happened on this deployment and is why this migration exists.
--
-- No column is added. The timestamp already carries everything the feature
-- needs: when it was deleted, and therefore when it expires. What is missing
-- is an index, because the retention sweep asks a question the schema has
-- never been asked before.
--
-- **A PARTIAL index, and that is the whole point of it.** The sweep runs
-- `WHERE deleted_at IS NOT NULL AND deleted_at < ?` every hour, and the trash
-- view runs `WHERE owner_id = ? AND deleted_at IS NOT NULL`. In both, the
-- selective term is `IS NOT NULL` — and on a healthy deployment that matches
-- almost nothing, because almost every board is alive. A full index on
-- `deleted_at` would store one entry per board, nearly all of them NULL, to
-- answer a query that wants the handful that are not. The `WHERE` clause below
-- makes the index hold only the rows in the trash: a few dozen entries rather
-- than one per board, and the sweep touches no live row at all.
--
-- SQLite has supported partial indexes since 3.8.0 (2013); better-sqlite3
-- ships far newer.
CREATE INDEX IF NOT EXISTS idx_boards_deleted_at
  ON boards (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Nothing already in the ground is dug up by the arrival of the gravedigger.
--
-- Every row that already has a `deleted_at` was deleted under the old rule,
-- where "deleted" meant hidden for ever and there was no way back and no way to
-- see it. Those people were never offered a window and never had a chance to
-- use one. Switching the sweep on without this line destroys, on the first
-- tick, every board deleted more than LAWHA_TRASH_RETENTION_DAYS ago — and the
-- first tick is at boot, before the server accepts a request, so the operator's
-- first sight of the new feature would be a log line counting what it had
-- already taken.
--
-- This deployment happens to have seven such rows and all of them happen to be
-- inside thirty days. That is luck, it is a property of one database, and it is
-- not something a migration may rely on.
--
-- The cost is that those boards' trash entries read as deleted at the moment of
-- the upgrade rather than at their real date. That is a cosmetic inaccuracy, on
-- a screen that did not exist until this migration ran, and it buys a hard
-- guarantee: no board is ever destroyed without having been restorable, and
-- visible as restorable, for a full retention window.
--
-- Runs exactly once — `runMigrations` records the version — so a row deleted
-- tomorrow keeps its own real timestamp.
UPDATE boards
   SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE deleted_at IS NOT NULL;
