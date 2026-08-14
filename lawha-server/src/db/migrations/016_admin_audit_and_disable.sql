-- Two things `/admin` needed and did not have: a record of what was done, and
-- a way to stop an account without destroying it. See ADR 0015.
--
-- ## The audit
--
-- Administrative actions were logged to stdout and nowhere else. That is a
-- real record, but only for somebody with a shell on the box and the patience
-- to grep a container's output, and it is gone the moment the log rotates —
-- while the thing it records, an `is_admin` row, outlives the session that
-- wrote it, survives a password rotation, and is invisible from every screen
-- the account's owner ever looks at. `routes/admin.ts` already says this in as
-- many words about the role grant; the answer is a table.
--
-- **The actor and target are stored as labels as well as ids, and the ids
-- carry no foreign key.** That is deliberate and it is the whole difference
-- between a log and a join:
--
--   * A log entry has to survive its subject. `deleteAccount` removes a user
--     row; a cascade would then quietly delete the record of what was done to
--     that account — which is exactly the record somebody would be looking for.
--   * A master-password session has no account behind it (migration 007), so
--     `actor_user_id` is genuinely NULL for those, and `actor_label` is the
--     only thing that can say who. It cannot say *which person* was holding
--     the password. That cost is migration 007's, not this table's, and it is
--     recorded rather than hidden: `via_master` makes it explicit on the row.
--
-- No pruning, no retention window. On a LAN deployment this table grows by a
-- handful of rows a year, and a log that deletes itself on a schedule nobody
-- chose is worse than one that grows.
--
-- ## Disabling
--
-- An administrator whose colleague has left could reset their password and
-- hope, or delete the account and take its boards with it. Neither is "this
-- person should not be able to sign in any more".
--
-- `disabled_at` is a timestamp rather than a flag so the record says *when*,
-- which is the question asked afterwards. NULL means active.
--
-- **It has to be enforced in three places, and enforcing it in one is
-- enforcing it nowhere** (invariant 21): the login route, the session
-- middleware that resolves a cookie onto `req.user`, and the socket
-- handshake's own resolver. Disabling an account whose owner is sitting in a
-- board with a live session must remove them from it, not wait for the cookie
-- to expire.

ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE TABLE IF NOT EXISTS admin_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  -- NULL for a master-password session, which is not an account.
  actor_user_id  TEXT,
  -- Denormalised on purpose: see above. Never NULL — an action always has an
  -- actor, even when the only thing that can be said about them is "the master
  -- password".
  actor_label    TEXT NOT NULL,
  via_master     INTEGER NOT NULL DEFAULT 0,
  action         TEXT NOT NULL,
  target_user_id TEXT,
  target_label   TEXT,
  -- Free text for the one extra fact an action needs — how many sessions a
  -- reset revoked, say. Never a credential: the generated-password rule in
  -- `routes/admin.ts` predates this table and is not relaxed for it.
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);
