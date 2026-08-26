-- An administrator can delete an account, and it waits thirty days (ADR 0031).
--
-- The counterpart to `disabled_at` from migration 016, and the two are
-- deliberately separate timestamps rather than one status column. They answer
-- different questions and can both be true: an account turned off in March and
-- deleted in April is a real sequence, and restoring the deletion must not
-- quietly turn it back on. A single `status` would have made that impossible
-- to express and the bug impossible to see.
--
-- **The boards are not stamped, and that is the design (ADR 0031).** A deleted
-- account's boards become unreachable because `BoardsRepository.getBoardAccess`
-- reads the owner's `deleted_at` alongside the board's own, not because
-- anything writes to `boards`. Stamping every owned board would mean
-- remembering which ones the account had *already* put in its own trash, so a
-- restore could put back only the right ones — two sources of truth that have
-- to agree for ever. Deriving makes a restore one UPDATE against this column.
--
-- No backfill. Migration 019 stamped its rows forward because `deleted_at` on
-- `boards` already existed and already held real deletions taken under a rule
-- with no way back. This column is new: every row is NULL, there is no history
-- to protect, and copying that stamp-forward would be cargo cult.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- Partial, for the same reason as `idx_boards_deleted_at` in migration 019:
-- the sweep and the admin list both select on `IS NOT NULL`, which on a healthy
-- deployment matches almost nothing. A full index would store one entry per
-- account, nearly all NULL, to answer a query that wants the handful that are
-- not.
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;
