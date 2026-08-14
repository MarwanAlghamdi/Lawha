-- The master password opens the administration panel, and it is not an account.
--
-- It used to sign you in AS one: `POST /auth/master` resolved an administrator
-- and minted an ordinary row in `sessions`. That kept every administrative
-- action attributable to a person, which is a real property and is the reason
-- it was built that way — but it also meant the credential silently borrowed
-- somebody's identity, and it made "who is this?" answerable only by reading
-- the log. The decision was reversed deliberately: this is the application's
-- administration password, not a way into anyone's account.
--
-- A separate table rather than a nullable `sessions.user_id`, and the
-- separation is the point rather than tidiness:
--
--   * `sessions.user_id` is `NOT NULL REFERENCES users(id) ON DELETE CASCADE`,
--     and dozens of routes read `req.user.id` straight out of it — boards,
--     folders, tags, scenes, files, membership. Making it nullable would
--     introduce an authenticated-but-user-less state into every one of them at
--     once, and the failure mode of missing one is a crash or, worse, a query
--     that silently matches nothing.
--   * An administration session must not be able to reach a board *at all*.
--     Here that is true by construction: this table is read by one middleware
--     that sets one flag, and `req.user` stays undefined, so every board route
--     refuses it exactly as it refuses an anonymous caller. There is nothing to
--     remember to check.
--
-- No `user_id` column, deliberately, not even a nullable one. There is nobody
-- to record.

CREATE TABLE admin_sessions (
  -- sha256(token), exactly as `sessions` does it: a database leak must not
  -- yield live sessions.
  token_hash   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);

CREATE INDEX idx_admin_sessions_expires ON admin_sessions (expires_at);
