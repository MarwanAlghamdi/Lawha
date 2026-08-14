# 0010 — board keys are escrowed, wrapped under the account password

- **Status:** accepted
- **Amends:** invariant 1. The plaintext room key still never leaves the client; a _wrapped_ copy now does.
- **Supersedes:** the claim in `data/boardKeys.ts` that "there is no recovery path through the server, because a recovery path through the server is exactly the thing end-to-end encryption rules out".

## Context

That sentence was true about the design and wrong about the trade, and the difference cost a real board.

A key lived in exactly two places: the `#key=` fragment of a share link, and an IndexedDB store. **IndexedDB is scoped per origin.** This deployment is reachable at `https://lawha.local`, at a Tailscale address, at a LAN address and at `localhost` — four separate, disjoint vaults on one laptop, in one browser, for one person. A board created at one address read as permanently locked at another, with no way back and nothing on screen explaining why.

It is not hypothetical. A board called "Do not touch" became unopenable while its ciphertext — 12 KB of scene and a 2.4 MB image — sat intact on the server. Its owner is the person who runs the box. Being the owner did not help: ownership is an authorization fact, and encryption is not.

The old locked screen made this worse. It said "open the board's share link on this device once and it will be remembered", and offered nowhere to put one. Following the advice meant hand-editing the address bar with an exact fragment.

## What was rejected

**Server-held keys.** Simplest thing that never loses work, and it ends the product. "The server cannot decrypt anything" is the first sentence of the README and the reason the project exists.

**Keep the crypto, make loss hard.** One canonical address, a downloadable key backup, the key shown in the Share panel, warnings before anything that strands a board. Cheap, safe, and it leaves durability depending on the user acting. Someone who ignores every prompt still loses everything. Parts of this are being done anyway — the canonical address in particular, because four vaults is a bug whatever else is true.

**A session with no user, for the master password.** Rejected in ADR 0009 for the administration panel and rejected again here for a different reason: an operator-held key would make every board readable by whoever runs the box, which is the same loss as server-held keys with extra steps.

## Decision

One master key per account, wrapped twice; every board key wrapped by the master.

```
password      ──PBKDF2(salt, 600k)──▶ wrapping key ──AES-GCM──▶ master key
recovery code ──PBKDF2(same salt)───▶ recovery key ──AES-GCM──▶ master key
master key    ──AES-GCM──▶ each board key
```

The indirection earns its place twice. A password change re-wraps **one** row rather than every board key — which matters because the client doing the change may hold only some of them. And it is what makes a recovery code possible at all: a second door to the same room, not a second copy of everything in it.

`PBKDF2-SHA256` rather than Argon2id, and that is a compromise. Argon2 is the better KDF and it is what the server already uses for password hashing, but in a browser it means shipping a WASM build. PBKDF2 is native to WebCrypto, needs no dependency, and 600,000 iterations meets current OWASP guidance. The count is stored per account rather than compiled in, so raising it later is a decision rather than a migration.

Two tables, not one nullable column on `sessions` — see migration 008. The salt is deliberately **not** the argon2 salt from `users`: reusing it would mean the value that authenticates and the value that decrypts came from the same input, and a server that can check a password could then derive the wrapping key.

## The cost, stated rather than buried

**Somebody who steals the database and cracks an account's password gets that account's boards.** Before this, they got nothing, no matter how weak the password was. That is a genuine reduction in what the encryption promises, and it was accepted deliberately by the product owner after being put to them in exactly these words.

What it buys: changing laptop, clearing a browser, or typing a different address stops destroying work. That was the failure actually happening, repeatedly, to the only people using the product.

## The sharp edge: administrator password reset

Wrapping under the password means **an administrator resetting a forgotten password leaves the account working and every board it owns permanently unreadable.** The most ordinary support action on the deployment becomes silent data destruction.

That is what the recovery code is for, and it is why it is not optional. Minted at first unlock, shown exactly once behind a checkbox that says it cannot be shown again, offered as copy and as a download. Only its sha256 is stored, so the server could not show it twice if it wanted to.

The `/admin` reset flow must say this at the point of resetting. A warning somewhere else is not a warning.

## What did not change

- The **server still cannot read a board.** Every value in `account_keys` and `board_keys` arrived already encrypted by a browser. Nothing on the server decrypts, and `keyEscrow.test.ts` on the server side deliberately contains no unwrapping — a test that needed to would be evidence the property had been lost.
- **A master-password administration session cannot reach the escrow.** It has no `req.user`, so `/api/keys` refuses it exactly as it refuses an anonymous caller. An administrator holding the application password does not thereby hold anybody's boards, and there is a test that walks that route to say so.
- **A board shared with three people is escrowed three times**, once under each person's own master. There is no shared secret between them and no way for the server to move a key from one escrow to another.
- **The local IndexedDB store still matters.** It is what makes the dashboard synchronous, what works with the escrow locked, and the only copy for a link visitor with no account.

## Consequences

- The first sign-in after this ships sets up an escrow and uploads whatever keys that browser already holds. That is what rescues the backlog rather than protecting only what happens next.
- `data/boardKeys.ts` is now a cache with a second copy behind it, and its doc comment says so.
- Boards whose keys exist on no device and in no saved link are **still gone**. Escrow can only protect keys it can see. "Do not touch" is recoverable only if the phone or laptop that made it still has the key.
- Two things in this design are worth revisiting and are not being done now: Argon2id in the browser once a WASM build is acceptable, and a second recovery factor for people who lose both the password and the code.

## Amendment — the unlocked master is cached in the browser (roadmap §4.18)

This ADR shipped with the master key held in a tab-scoped variable and persisted nowhere, so a reload cost one PBKDF2 run and a stolen unlocked laptop yielded no boards without the password. That rule is withdrawn. It could not survive its own consequence: a session restored from its cookie has no password to derive from, so the master was unobtainable, the sync could not unwrap, and the dashboard reported "no key in this browser" about a key the server was holding — on the person's own account, at every address but the one they last signed in at. It was reported twice as the product being broken, which is the correct reading of it.

**What changed.** `restoreEscrow()` reads the master from `lawha-escrow`, an IndexedDB store scoped to this origin exactly like the board-key store, and the session loader calls it as soon as a cookie resolves to a real account. `unlockEscrow`, `setUpEscrow` and `recoverEscrow` write it on the way past. `lockEscrow()` deletes it, so sign-out remains an action rather than a gesture. A master-password administration session never restores one — it has no escrow, and adopting whatever this browser last cached would hand it somebody else's boards.

**What it costs.** Disk access to a browser profile now yields every board the account has escrowed, where before it yielded the subset that profile had opened. The session cookie lives in the same profile and already yields the account, so the delta is narrower than it first reads — but it is real, and it is the deliberate price of "an account sees its boards from anywhere, without being asked twice". The properties this ADR's Decision section claims are otherwise unchanged: the plaintext key still never reaches the network, and the server still cannot decrypt anything.

Everything under "Boards whose keys exist on no device and in no saved link are still gone" stands untouched. Caching a master cannot conjure a board key that was never escrowed; the only cure for those remains signing in once at the address whose browser still holds them, which uploads them.
