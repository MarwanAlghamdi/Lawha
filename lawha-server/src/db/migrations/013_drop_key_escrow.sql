-- The key escrow goes. Nothing on this server encrypts or decrypts any more.
--
-- ADR 0012 removed the encryption; this removes the machinery that existed to
-- get a key to a browser. Three tables and the whole of `lib/serverEscrow.ts`
-- go with them, which means the answer to "can this server read my boards" is
-- no longer "yes, in one file" — it is "there is nothing to read past".
--
-- **Gated, not scheduled.** `scripts/convert-plaintext.mjs` exits non-zero
-- while any LIVE board is still stored as ciphertext, and this was written only
-- once that count had been driven down deliberately:
--
--   * 8 boards converted from the server's own escrow copy;
--   * 9 more were provably empty — an 18-byte AES-GCM ciphertext is 2 bytes of
--     plaintext, which is `[]` and nothing else;
--   * 1 was recovered by trying every key we held against every scene, because
--     duplicating a board copies its ciphertext verbatim and therefore shares
--     the source's key. That one was 12 KB and its owner had called it
--     "Do not touch copy".
--
-- **Four live boards were still ciphertext when this ran, and dropping these
-- tables does not harm them.** That is the whole reason it was safe to proceed:
-- the server could never open those four — they have no escrow row it can
-- reach, which is precisely why they are stuck — so it is giving up nothing it
-- had. Their keys are in the IndexedDB of the browser that made them, and the
-- client keeps its local key store and its legacy decrypt for exactly that
-- reason. Opening one of those boards on the right browser still converts it.
--
-- What would NOT have been safe, and was not done: deleting the client's local
-- key store at the same time. That is the only remaining copy of those four
-- keys anywhere.
--
-- The material was exported to `~/lawha-backups/key-material/` (0600, in a 0700
-- directory) immediately before this ran, so a key that surfaces later still
-- has something to pair with.
--
-- Order matters only in that `board_keys` and `account_keys` are independent of
-- each other; neither is referenced by anything that survives.

DROP TABLE IF EXISTS board_keys;
DROP TABLE IF EXISTS account_keys;

-- The server's own RSA keypair, from ADR 0011. It existed to open a master key
-- an administrator's password reset needed; a reset re-wraps nothing now, so
-- this is the last thing on the deployment capable of decrypting anything.
DROP TABLE IF EXISTS server_escrow_keys;
