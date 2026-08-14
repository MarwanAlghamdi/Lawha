# 0011 — The server can recover a master key, and Lawha is no longer end-to-end encrypted

**Status:** accepted. **Supersedes ADR 0010's central promise**, and amends invariant 1.

**Affects:** `lawha-server/src/lib/serverEscrow.ts` (new), `db/migrations/010_server_escrow.sql`, `db/repositories/keyEscrow.ts`, `http/routes/keys.ts`, `http/routes/admin.ts`, `excalidraw-app/data/keyEscrow.ts`, `lawha/auth/useLawhaSession.ts`, `lawha/auth/LawhaEscrowUnlock.tsx`, and the deletion of `lawha/auth/LawhaRecoveryCode.tsx`.

## Context

ADR 0010 escrowed board keys under a per-account master key, wrapped by a key derived from the account password. The server held a locked box it could not open. Because a password change re-wraps the master, and an administrator resetting a password does not have the old one, that design needed a second door — the **recovery code**: 24 characters, shown once at first sign-in, wrapped around the same master.

It worked. Every part of it was tested. And it was the wrong shape for this deployment:

1. **It put an unbounded obligation on each person.** "I have saved this code somewhere safe" is a checkbox, not a fact. The honest base rate for a 24-character string that matters on a day that may never come is that nobody has it.
2. **It made the ordinary support action dangerous.** An administrator resetting a forgotten password left the account intact and every board it owned unreadable, unless the person produced a code they were asked to keep months earlier.
3. **It was defending against a threat that does not exist here.** Lawha runs on one machine inside one company, on a LAN, administered by the people who use it. The adversary ADR 0010's promise excluded — an operator who reads the database — is the same person being asked to run the backups. The guarantee was real and it was bought with somebody else's inconvenience.

The user's instruction was direct: remove the recovery code, and let an administrator reset a password from a button beside each account.

**That instruction cannot be satisfied without the server being able to decrypt.** Re-wrapping a master requires the plaintext master, which requires the old password or the recovery code. An administrator has neither. There is no third option, and pretending otherwise would have produced a reset button that silently destroys the work it was called to rescue.

## Decision

**The server holds a third wrapping of each master key, under a keypair only it can use.**

    password           ──PBKDF2(salt, 600k)──▶ wrapping key ──AES-GCM──▶ master key
    server public key  ──RSA-OAEP──────────────────────────────────────▶ master key
    master key         ──AES-GCM──▶ each board key

1. **RSA-OAEP-2048, generated once, lazily, on first use.** The browser only ever holds the public half, so the plaintext master never crosses the wire in either direction — a compromised tab, a stolen bundle or an XSS cannot decrypt anybody's escrow. Only this server process, holding the private half, can. That is the one piece of cryptographic care left in the design and it is worth keeping: "the server can decrypt" and "anything that can reach the API can decrypt" are very different failures.

2. **One keypair, enforced by a `CHECK (id = 1)`.** A second would orphan every master wrapped under the first, and the symptom would arrive months later as "some accounts cannot be recovered".

3. **The keypair lives in the database, not in `lawha.env`.** A file the operator must not lose is a file the operator will eventually lose, and a keypair beside the data it opens is at least backed up by the same command. The cost is that database theft alone is now sufficient — see Consequences. Splitting them would defend against exactly one threat (a stolen `.db` file with no filesystem access) and cost a configuration step whose omission silently disables recovery.

4. **An administrator's password reset re-wraps the master, before it changes the password.** Order is the safety: a password that has already changed cannot be put back, so a failure after that point would leave the account locked out with no retry.

5. **A reset is REFUSED when there is no server copy.** Accounts created before this ADR have a working escrow and nothing to recover from; `master_by_server` is nullable for exactly that reason. `GET /api/keys` reports `hasServerCopy` so the admin panel can say why beforehand rather than discovering it at reset time. Performing the reset anyway would be the old behaviour with none of the old escape hatch.

6. **The client uploads a copy at the next successful unlock** (`ensureServerCopy`), because that is the only moment the plaintext master exists. Best-effort and silent: an account without one still works, it simply cannot be recovered.

7. **The recovery code is deleted outright** — no minting, no storage, no redemption, and migration 010 drops its columns. Keeping unreadable ciphertext of a master key is strictly worse than deleting it, and leaving the columns would invite a half-rebuild against something nothing writes. The `needs-recovery` escrow state goes with it: a reset now produces a password that works.

## Consequences

**Lawha is no longer end-to-end encrypted, and no document should claim otherwise.** Anyone with this database can decrypt every board on the deployment. Previously they got ciphertext and a locked box.

The security boundary is now operational rather than cryptographic: the machine, its disk, and the backup archive — which since §4.21 contains the database _and_ the configuration, and is therefore a complete set of keys to everything. `~/lawha-backups` should be `0700`, and an off-host mirror inherits the same obligation.

**What is still true**, and worth stating so the remaining guarantees are not assumed away with the main one:

- The plaintext master never appears in a request body, in either direction.
- The password is never sent, never stored, and never derivable from anything on the server.
- A board reached by a share link with no account is still local-only key material; the server has no copy of a key it was never given.
- The unwrapping lives in exactly one file, `lib/serverEscrow.ts`, so "who can decrypt a board" has one answer in one place rather than being a property that must be audited for.

**Invariant 1 is amended again.** It read "the plaintext room key never leaves the client", then became "a wrapped copy is escrowed" under ADR 0010. It is now: _the plaintext key never leaves the client, and the server holds a wrapped copy it can open._

**A path was closed on the way past.** A wrong password and an escrow that cannot be opened are still indistinguishable from the client, so the unlock form still refuses to say "wrong password" — but it now points at an administrator's reset rather than at a code. Telling somebody their correct password is wrong is how people retype a working credential until they give up.

**Not done here:** the reset control still lives behind a select-then-form flow in `LawhaAdminCard` rather than as a button beside each account row. That is presentation — the reset itself works, preserves the boards, and refuses when it cannot — and it is recorded in the roadmap.

The `.lw-admin__escrow` panel WAS corrected in this change, because leaving it would have been worse than not writing it: it told an administrator that a reset destroys the account's boards and to ask for a recovery code first. Under this ADR both halves are false, and a warning that is false in the direction of "do not do the safe thing" stops people using a feature that works.
