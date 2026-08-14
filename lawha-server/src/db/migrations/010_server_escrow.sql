-- The master key, wrapped a third way: under a key this SERVER holds.
--
-- THIS REVERSES THE CENTRAL PROPERTY OF ADR 0010, AND OF THIS PROJECT.
-- Read docs/adr/0011-server-recoverable-escrow.md before changing anything
-- here. In one sentence: the server can now decrypt every board, and that was
-- chosen deliberately in exchange for an administrator being able to reset a
-- forgotten password without destroying the account's work.
--
-- What it replaces is the recovery code, which is deleted in this migration.
-- That code was the only path back from an administrator's password reset, and
-- it worked — but it put the burden on each person to keep a 24-character
-- string safe for a day that might never come, and the honest outcome of "I
-- have saved this somewhere" is usually that nobody has. On a LAN deployment
-- inside one company, where the machine holding the database is already
-- trusted with everything on it, an administrator who can help is worth more
-- than a cryptographic guarantee against an administrator nobody is defending
-- against.
--
-- WHAT AN ATTACKER GETS with this table and the database: every board, in the
-- clear. Previously they got ciphertext plus a locked box. The mitigations are
-- operational rather than cryptographic now — the machine, the disk, and the
-- backup archive (which holds this too) are the security boundary.

-- The server's own keypair, RSA-OAEP-2048, generated once on first boot.
--
-- ASYMMETRIC, and that is the one piece of cryptographic care left in this
-- design. The browser wraps the master under the PUBLIC key, so the plaintext
-- master still never crosses the wire and still never sits in a request body —
-- only this server, holding the private half, can open it. A symmetric secret
-- would have had to reach the browser to be usable, which would have put the
-- key that opens everything into every tab.
--
-- One row, enforced by the CHECK. A second keypair would silently orphan every
-- master wrapped under the first, and the symptom would be "some accounts
-- cannot be recovered" long after the cause.
CREATE TABLE server_escrow_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- SPKI, base64. Handed to any authenticated client that asks.
  public_key TEXT NOT NULL,
  -- PKCS8, base64. Never leaves this process.
  --
  -- In the database rather than in lawha.env, which is a real trade and not an
  -- oversight: a file the operator must not lose is a file the operator will
  -- eventually lose, and a keypair that lives beside the data it opens is at
  -- least backed up by the same command. It also means database theft alone is
  -- sufficient — see the warning above. Splitting them would buy defence
  -- against exactly one threat (a stolen database file with no filesystem
  -- access) and cost a configuration step that, if skipped, silently disables
  -- recovery for every account created afterwards.
  private_key TEXT NOT NULL,

  created_at INTEGER NOT NULL
);

-- The master key, wrapped under the public key above.
--
-- Nullable, because it can only be written by a browser that has the plaintext
-- master in hand — which means at sign-in, by that account holder. An account
-- that has not signed in since this migration has no copy here and cannot be
-- recovered by an administrator until it does. That is a real gap with a real
-- symptom, so `GET /api/keys` reports whether the copy exists and the admin
-- panel says so beside the account rather than offering a reset that would
-- quietly destroy the boards.
--
-- RSA-OAEP has no separate IV, so there is one column here and not two.
ALTER TABLE account_keys ADD COLUMN master_by_server TEXT;

-- The recovery code is gone.
--
-- SQLite has supported DROP COLUMN since 3.35 and better-sqlite3 ships well
-- past that, so these are dropped rather than left as dead nullable columns.
-- Leaving them would mean the next person reading this schema finds two
-- wrapping paths and one implementation, which is how a "recovery" feature
-- gets half-rebuilt against columns nothing writes.
--
-- Dropping is destructive and deliberately so: these hold wrappings under
-- codes that no longer have any code path to redeem them. Keeping unreadable
-- ciphertext of a master key is strictly worse than deleting it.
ALTER TABLE account_keys DROP COLUMN master_by_recovery_iv;
ALTER TABLE account_keys DROP COLUMN master_by_recovery;
ALTER TABLE account_keys DROP COLUMN recovery_code_hash;
