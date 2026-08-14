-- Email, password recovery, and a per-user laser colour.
--
-- 001 deliberately had no email column: the original brief ruled out email
-- signup entirely. That was reversed — an account with no recovery path is one
-- forgotten password away from being lost, and the admin CLI does not scale
-- past the person who owns the machine.
--
-- Email is still not an identifier. You sign in with your username; the address
-- exists so a reset can be addressed to you, and nothing else is keyed on it.

-- Nullable, not NOT NULL. The shared `anonymous` stand-in has no address and
-- must not acquire one, and any account created before this migration keeps
-- working — the account page prompts for an address instead of locking them
-- out. Registration requires it going forward; that rule lives in the API.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_lower TEXT;

-- Partial index: uniqueness applies to the accounts that have an address, so
-- the many rows without one do not all collide on NULL.
CREATE UNIQUE INDEX idx_users_email_lower
  ON users (email_lower)
  WHERE email_lower IS NOT NULL;

-- Index into COLLABORATOR_PALETTE for the laser trail. NULL means "follow my
-- cursor colour", which is what almost everyone wants; it is a separate column
-- so that someone presenting on a busy board can pick something louder without
-- changing the colour their cursor and avatar have all session.
ALTER TABLE users ADD COLUMN laser_color_index INTEGER;

-- Reset tokens are stored hashed, exactly as sessions are: a database leak must
-- not hand out account takeovers. Rows are kept after use rather than deleted
-- so a replay is distinguishable from an unknown token in the logs.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE INDEX idx_password_resets_user ON password_resets (user_id);
CREATE INDEX idx_password_resets_expires ON password_resets (expires_at);
