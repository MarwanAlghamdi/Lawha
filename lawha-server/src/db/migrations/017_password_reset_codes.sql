-- One-time codes so an account holder can reset their OWN password.
--
-- `/admin` could set any account's password directly, which meant the
-- administrator setting it now knew it — and nothing that account did
-- afterwards could be attributed to the person who owns it. This table
-- replaces that: an administrator mints a code, the account holder redeems
-- it themselves at /reset/:code, and the administrator never learns the
-- credential. See docs/adr/0021-admin-password-reset-codes.md
-- for the full argument; this comment is about the two decisions in the
-- shape below that a future reader will otherwise try to "fix".
--
-- Modelled on `board_invites` (migration 015), which solved this shape
-- already: a code that is looked up once, can be redeemed once, and can
-- expire or be revoked out from under it.
--
--   * **`created_by` is nullable, deliberately.** A master-password session
--     has no `req.user` (migration 007) — `auditActor` already handles this
--     by labelling it "the master password". `NOT NULL` here would crash the
--     flow in precisely the recovery scenario it exists for: every
--     administrator locked out, reaching for the one credential that has no
--     account behind it.
--   * **`expires_at` is NOT NULL**, unlike `board_invites` where NULL means
--     "never". An invite that never expires is a decision an owner makes
--     about their own board. A password reset that never expires is a
--     liability sitting in this table waiting to be found, not a courtesy —
--     nothing that mints a code is allowed to leave this unset.
--
-- **`code_hash` is `sha256(code)`, never the code itself** — the same
-- protection `sessions.token_hash` (001_init.sql) gives a session token,
-- applied to a credential with an identical property: design spec §5 calls a
-- reset code "the entire credential" on its redemption route, no session or
-- username alongside it, so it carries the same entropy `tokens.ts` gives a
-- session token (both 32 random bytes). A leaked copy of this table in the
-- clear would have handed over every live, unexpired reset link outright —
-- no cracking required, for up to an hour each. Hashed, it gives up nothing
-- a leaked `sessions` table does not already have to withstand. The
-- plaintext code exists only in `PasswordResetCodesRepository.create`'s
-- return value — generated there, handed to its one recipient, and never
-- written down again anywhere, including an audit row.
--
-- Single-use is `redeemed_at`, the same shape as an invite's redemption.
-- `locked` records which of the two admin actions minted the row — "send a
-- reset code" leaves it 0 and the old password keeps working; "lock and
-- reset" sets it 1, having already made the account unreachable by writing
-- the same not-a-valid-argon2-hash sentinel `anonymousUser.ts` uses for its
-- stand-in account, rather than adding a second mechanism or a
-- `password_reset_required` column. `locked` is what the mint did, not a
-- live flag this table has to keep in sync with the account.
--
-- `ON DELETE CASCADE` on `user_id` means deleting an account takes its
-- outstanding codes with it, the same as a board invite going with its
-- board.

CREATE TABLE password_reset_codes (
  -- sha256(code): a database leak must not yield live reset links, the same
  -- reasoning sessions.token_hash (001_init.sql) applies to a session token.
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  locked      INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes (user_id);
