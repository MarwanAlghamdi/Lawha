# 0012 — Lawha stores scenes in the clear, and a board opens because you may open it

**Status:** accepted. **Supersedes ADR 0010 and ADR 0011.** **Retires invariant 1.**

**Affects:** `excalidraw-app/data/storage/lawha.ts`, `data/fileEncoding.ts` (new), `data/FileManager.ts`, `data/boardKeys.ts`, `data/index.ts`, `collab/Portal.tsx`, `collab/Collab.tsx`, `routes/BoardRoute.tsx`, `lawha/home/HomeRoute.tsx` and the board card/row, `lawha/auth/useLawhaSession.ts`, `lawha-server/src/http/routes/keys.ts` and `scene.ts`; and the deletion of `lawha/auth/LawhaEscrowUnlock.tsx`, `lawha/auth/escrowPassword.ts` and `lawha/home/LawhaHomeEscrowNotice.tsx`.

## Context

Every board was encrypted with an AES key the client minted. The key had to _reach_ a browser before the board would open, and by the time this was written there were four ways it could, each with its own failure:

1. the `#key=` fragment of a share link — so a board shared with you was ciphertext until somebody sent you one, and the dashboard drew a padlock over it until they did;
2. this origin's IndexedDB — scoped per origin, so the same person on the same laptop had disjoint vaults at `https://lawha.local` and at an IP;
3. the escrow (ADR 0010), openable by a key derived from the account password — which a session restored from a cookie does not have;
4. a cached master in IndexedDB, added when (3) turned out to leave people locked out of their own boards.

The reported symptom was the honest summary of all four: **"my own boards say _This board is locked here_ and ask for my password"**, plus a padlock on every board anyone had shared.

ADR 0011 had already given the server a copy of every account's master key, wrapped under a keypair only it holds, so that an administrator could reset a forgotten password without destroying that account's boards. It said so plainly: _"Lawha is no longer end-to-end encrypted, and no document should claim otherwise. Anyone with this database can decrypt every board."_

**That is the fact this decision follows from.** Once the server can read every board, the encryption is not protecting the scenes from the server; it is only deciding which browsers can display them. It had stopped buying a security property and was still charging the full price — a locked screen, a password prompt, a padlock, and four separate mechanisms whose job was to undo each other.

## Decision

**Scenes, socket traffic and image files are stored and transmitted in the clear. Authorization is `resolveBoardPermission` and nothing else.**

1. **A zero-length IV means plaintext.** `board_scenes.iv` is `NOT NULL` and SQLite cannot alter a column, so the alternative was the twelve-step table rebuild. An empty blob lets an encrypted row and a plaintext row live in the same column while the estate converts — which is what makes the migration lazy and reversible rather than one irreversible sweep. The same convention rides the socket: the relay already forwards `(payload, iv)` opaquely, so **`lawha-server/src/socket/` needed no change at all** and invariant 15 is untouched. It also means a tab running the previous build can sit in a room with a new one during a deploy.

2. **Conversion is client-driven, because that is where the keys are.** Measured against the live database before any of this shipped: of the 16 live boards with a stored scene, the server could open **7**. The other 9 have no escrow row it can reach, and their keys exist only in the IndexedDB of the browser that made them. So `loadFromBackend` rewrites a legacy scene in the clear the moment it successfully reads one — at the revision it was read at, so a concurrent write wins the race instead of being clobbered. A server-side sweep handles what it can reach and **names what it cannot**.

3. **The server hands a board key to anybody already entitled to the board** (`GET /api/keys/boards/:id`), for as long as any ciphertext remains. This is what removed the locked screen on day one, before a single byte had been converted. It is gated on the same `resolveBoardPermission` the scene read, the relay and the file upload use, and it admits a link guest, because a link visitor is a narrower principal and not an absent one (invariant 22).

4. **Share links carry no key.** New links are `/b/<id>`; an inbound `#key=` is still parsed so every link already sent out keeps working.

5. **A missing key is not a missing link.** `getBoardLinkData` used to return null without one, which made `isCollaborationLink` false, which meant `/b/<id>` did not join its room — invariant 25, and it would have broken for every board created after this change, because those boards have no key to find.

6. **Files get a Lawha-local container** (`data/fileEncoding.ts`) rather than a modified upstream one. `compressData` requires an `encryptionKey` and its framing helpers are module-private, so making files plaintext through it meant exporting internals or adding an option — new divergence in `packages/`, which **invariant 10 caps** and which the roadmap already records running over. The read path still delegates to upstream `decompressData` for anything written before this.

7. **`exportToBackend` keeps its encryption**, and this is not an oversight. That path uploads to `BACKEND_V2_POST` — upstream Excalidraw's public service, a third party on the internet that has never held a key and must not start. None of the reasoning above reaches it: the fragment is genuinely the only place that key exists. It is inert in production (`.env.production` blanks the URLs) and live in dev against `json-dev.excalidraw.com`, so it is a real upload and not a dead branch.

## Consequences

**Invariant 1 is retired, not amended.** It read "the plaintext room key never leaves the client", became "a wrapped copy is escrowed" under 0010, then "the server holds a wrapped copy it can open" under 0011. There is no room key to make a claim about.

**Invariant 21 is now load-bearing alone.** _A permission enforced in one layer is not enforced._ It was one guarantee among several; it is the only one. The four places `canEdit` is checked — the scene write, the relay's broadcast path, the client's view mode, and the file upload in `http/routes/files.ts` — must continue to move together, and there is no longer a second mechanism that would make a mistake there merely embarrassing.

**Invariant 18 survives, with a different reason, and must not be deleted.** It says Lawha needs a secure context. That was because every board key was minted with `window.crypto.subtle`. No key is minted now — but `generateIdFromFile` still computes a file id with `crypto.subtle.digest` (`packages/excalidraw/data/blob.ts`), which browsers withhold outside HTTPS and `localhost` exactly as before. The rule is unchanged; only its justification moved.

**A share link's whole secret is now the board id.** 10 random bytes (`ROOM_ID_BYTES`), plus `link_access` having to be on. That is comparable entropy to what a fragment carried — but **a path is sent to the server and a fragment is not**, so board ids now appear in access logs and in any proxy in front of them. Stated here rather than discovered later.

**What is still true:**

- The password is never sent, never stored, and nothing is derived from it. It authenticates and does nothing else.
- `avatar_on_cursor` still gates the avatar bytes at the only door to them, and migration 012 turns it off by default.
- The security boundary is operational, as ADR 0011 already established: the machine, its disk, and the backup archive. `~/lawha-backups` should be `0700`.

**The recovery story got simpler by subtraction.** An administrator's password reset no longer has to re-wrap anything, so the "refused because there is no server copy" branch — and the accounts it stranded — cease to exist.

**Done since, in migration 013.** The key material is gone: `account_keys`, `board_keys` and `server_escrow_keys` are dropped, and `lib/serverEscrow.ts`, `db/repositories/keyEscrow.ts`, `http/routes/keys.ts` and `data/keyEscrow.ts` are deleted. Nothing on the deployment can decrypt anything, because there is nothing left to decrypt with.

Getting there took four routes rather than the one this ADR anticipated, and the last two were not foreseen:

1. **8 boards** from the server's own escrow copy — the sweep described above.
2. **9 boards** that were provably empty. An AES-GCM ciphertext is the plaintext plus a 16-byte tag, so an 18-byte scene decrypts to 2 bytes, and the only 2-byte scene is `[]`. Lossless by arithmetic rather than by assumption.
3. **1 board** by trying every key we held against every scene. Duplicating a board copies its ciphertext verbatim, so a copy shares its source's key — the same fact that once produced a duplicate nobody could open, working the other way. That board was 12 KB and its owner had called it "Do not touch copy"; it came back with 18 elements.
4. The client converting on open, which is what the remaining four are still waiting for.

**Four live boards were still ciphertext when 013 ran, and dropping the tables cost them nothing.** That is why it was safe: the server could never open those four — no escrow row it could reach, which is exactly why they are stuck — so it gave up nothing it had. Their keys are in the IndexedDB of the browser that made them.

**So `data/boardKeys.ts` survives, deliberately reduced to a local read.** It is now the only copy of those four keys anywhere, and deleting it alongside the server tables would have destroyed them. It goes when the last stored ciphertext does; `scripts/convert-plaintext.mjs` prints the count and exits non-zero while any live board remains.

The material was exported to `~/lawha-backups/key-material/` (0600, in a 0700 directory) immediately before the drop, so a key that surfaces later still has something to pair with.
