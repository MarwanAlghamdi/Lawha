-- Board keys, escrowed — so that losing a browser stops meaning losing the work.
--
-- This reverses invariant 1 in letter and keeps it in spirit, and the
-- distinction is the whole design. Until now a board key existed in exactly two
-- places: the URL fragment of a share link, and an IndexedDB store in one
-- browser. IndexedDB is scoped per ORIGIN, so the same person on the same laptop
-- had a different, disjoint vault at `https://lawha.local` and at
-- `https://<the same box's IP>:9002` — and a board made at one address read as
-- "locked" at the other, with no way back. That is not a hypothetical: it is how
-- a real board on this deployment became unopenable, with its ciphertext sitting
-- intact on disk and nobody able to read it.
--
-- What is stored here is a key that has already been encrypted in the browser
-- with a key the server has never seen and cannot derive. The PLAINTEXT key
-- still never leaves the client. What leaves is a locked box.
--
-- The cost is stated rather than buried, because it is real and it was accepted
-- deliberately (ADR 0010): somebody who steals this database AND cracks an
-- account's password gets that account's boards. Before this change they got
-- nothing at all, no matter how weak the password was. In exchange, a user who
-- changes laptop, clears their browser, or types a different address keeps their
-- work — which is the failure that was actually happening.
--
-- Two tables rather than one, and the split is what makes a password change
-- cheap. Wrapping every board key directly with a password-derived key would
-- mean re-wrapping all of them on every password change, from a client that may
-- hold only some of them. Instead one random master key per account is wrapped
-- by the password, and every board key is wrapped by the master. A password
-- change re-wraps exactly one row.

-- One row per account. The master key, wrapped twice.
CREATE TABLE account_keys (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

  -- Input to the browser's key derivation. Public by necessity: the client
  -- needs it before it can derive anything, so it is served to anyone holding
  -- a session for this account. A salt is not a secret; it exists so that two
  -- people with the same password do not produce the same wrapping key, and so
  -- that a precomputed table is useless.
  --
  -- DELIBERATELY NOT the salt used for the argon2id password hash in `users`.
  -- Reusing it would mean the value the server stores for authentication and
  -- the value that unlocks the boards were derived from the same input with the
  -- same parameters, and a server that can check a password could then also
  -- derive the wrapping key. Different salt, different KDF, different purpose.
  kdf_salt TEXT NOT NULL,
  -- Recorded rather than assumed, so raising the cost later does not strand
  -- every account minted before the change. The client uses what it is told.
  kdf_iterations INTEGER NOT NULL,

  -- AES-GCM(derive(password, kdf_salt), master_key). Base64, iv separate.
  master_by_password_iv TEXT NOT NULL,
  master_by_password TEXT NOT NULL,

  -- The same master key, wrapped again under a code the account holder wrote
  -- down. This is not a convenience: without it, an administrator resetting a
  -- forgotten password would leave the account intact and every board it owns
  -- permanently unreadable — turning the ordinary support action into silent
  -- data destruction. Nullable only because an account can exist from before
  -- this migration; the client mints one at first unlock.
  master_by_recovery_iv TEXT,
  master_by_recovery TEXT,

  -- sha256 of the recovery code, for the same reason session tokens are hashed:
  -- a database leak must not hand over a working credential. Used only to tell
  -- somebody they typed it wrong before spending an argon2 derivation on it.
  recovery_code_hash TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per (account, board). The board key, wrapped by that account's master.
--
-- Keyed on the account and not on the board, because a board shared with three
-- people is escrowed three times, once under each person's own master key.
-- There is no shared secret between them and no way for the server to move a
-- key from one person's escrow to another's — which is what keeps this from
-- quietly becoming a server-held key.
CREATE TABLE board_keys (
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,

  -- AES-GCM(master_key, board_key). Base64.
  iv         TEXT NOT NULL,
  ciphertext TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (user_id, board_id)
);

-- The dashboard asks "which of my boards are escrowed?" on every load, so the
-- primary key's leading column already serves it. Declared anyway for the
-- cascade delete, which scans by board.
CREATE INDEX idx_board_keys_board ON board_keys (board_id);
