#!/usr/bin/env node
/**
 * Converts stored scenes from ciphertext to plaintext, in place.
 *
 * ADR 0012 removed the encryption. This is the half of the migration that SQL
 * cannot do — the rows are AES-GCM ciphertext and opening one needs WebCrypto
 * and a walk through the escrow, neither of which exists in a `.sql` file.
 *
 * **It is deliberately NOT the main conversion path, and it cannot be.**
 * Measured against the live database before any of this shipped: of the 16 live
 * boards holding a stored scene, this script can open **7**. The other 9 have
 * no `board_keys` row whose owner has a `master_by_server`, so their keys exist
 * only in the IndexedDB of the browser that made them — which is where
 * `loadFromBackend` converts them, once, the first time somebody opens the
 * board. This sweep is the supplement; the client is the migration.
 *
 * Every board it cannot convert is NAMED, with its owner and its byte size.
 * A conversion that reports only successes is how "we migrated everything"
 * becomes false with nobody noticing, and the count this prints is the gate on
 * deleting the key material at all — do that while a single row is still
 * ciphertext and those boards become unreadable by anyone, permanently.
 *
 * **A password opens a second door**, for accounts the server copy cannot
 * reach. `master_by_server` only exists for accounts that signed in after ADR
 * 0011 shipped; older ones still have `master_by_password`, which PBKDF2 opens
 * given the password. That is not a bypass of anything — it is the same
 * derivation the browser does, run here because the browser holding the key is
 * not always available. Pass `--as <username>:<password>` (repeatable).
 *
 * Read-only unless `--apply` is passed. Take a backup first:
 *
 *   LAWHA_DB_PATH=~/lawha-data/lawha.db yarn backup ~/lawha-backups
 *   LAWHA_DB_PATH=~/lawha-data/lawha.db node scripts/convert-plaintext.mjs
 *   LAWHA_DB_PATH=~/lawha-data/lawha.db node scripts/convert-plaintext.mjs --apply
 *   LAWHA_DB_PATH=~/lawha-data/lawha.db node scripts/convert-plaintext.mjs --as gov1:secret --apply
 */

import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const dbPath = path.resolve(
  process.env.LAWHA_DB_PATH ?? "./lawha-data/lawha.db",
);

/**
 * REFUSED OUTRIGHT against a SQLCipher database, before the driver below opens
 * anything.
 *
 * This script links PLAIN `better-sqlite3` and, unlike `backup.mjs` and
 * `restore.mjs` (Task 7B), was never taught `LAWHA_DB_KEY` — deliberately: it
 * is a one-time ADR 0012 migration for scenes written before that ADR, with no
 * entry in `package.json` and nothing left to do on a deployment that has
 * already run it. A deployment new enough to have encrypted its database is
 * new enough to have no ciphertext scenes left.
 *
 * It refuses rather than simply failing on the first page read, because the
 * two are not the same. Opening a database with a SQLite library that is not
 * the one the server is using is the hazard `src/db/index.ts` documents at
 * length, and a `--apply` run opens READ-WRITE. Reading sixteen bytes is
 * cheaper than finding out what that does.
 *
 * `SQLite format 3\0`, with the NUL written `\0` for the reason recorded in
 * `src/db/index.ts`: a raw NUL makes git call the file binary.
 */
const SQLITE_MAGIC = "SQLite format 3\0";

if (fs.existsSync(dbPath)) {
  const handle = fs.openSync(dbPath, "r");
  const header = Buffer.alloc(SQLITE_MAGIC.length);
  const read = fs.readSync(handle, header, 0, header.length, 0);
  fs.closeSync(handle);

  if (read !== header.length || header.toString("latin1") !== SQLITE_MAGIC) {
    process.stderr.write(
      `lawha: ${dbPath} is not a plain SQLite database — it is encrypted ` +
        "(LAWHA_DB_KEY), or damaged.\n" +
        "lawha: This one-time ADR 0012 conversion does not know that key and " +
        "will not open it\n" +
        "lawha: with the wrong driver. Nothing has been changed.\n",
    );
    process.exit(1);
  }
}

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });

/**
 * The server's escrow keypair, generated lazily by `lib/serverEscrow.ts`.
 *
 * Absent means no account has ever uploaded a wrapped master, so nothing here
 * is openable — reported rather than crashed on, because it is a real state
 * for a database restored from before ADR 0011.
 */
const keypair = db
  .prepare("SELECT private_key FROM server_escrow_keys WHERE id = 1")
  .get();

const unb64 = (value) => Buffer.from(value, "base64");

/**
 * Passwords supplied on the command line, as `username -> password`.
 *
 * Read once here rather than threaded through, and never logged — the report
 * below names accounts and boards, never a credential.
 */
const passwords = new Map(
  process.argv
    .map((arg, index) =>
      arg === "--as" ? process.argv[index + 1] : arg.startsWith("--as=") ? arg.slice(5) : null,
    )
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(":");
      return at < 0 ? null : [pair.slice(0, at), pair.slice(at + 1)];
    })
    .filter(Boolean),
);

/**
 * Opens a master from its password copy, exactly as the browser would.
 *
 * PBKDF2-SHA256 at the account's own stored iteration count — read from the
 * row rather than assumed, because it is per-account precisely so it can be
 * raised without stranding anybody.
 */
const openMasterByPassword = async (row, password) => {
  try {
    const material = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(password, "utf8"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await webcrypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: unb64(row.kdf_salt),
        iterations: row.kdf_iterations,
        hash: "SHA-256",
      },
      material,
      256,
    );
    const key = await webcrypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    return Buffer.from(
      await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(row.master_by_password_iv) },
        key,
        unb64(row.master_by_password),
      ),
    );
  } catch {
    return null;
  }
};

const openMaster = async (masterByServer) => {
  if (!keypair?.private_key || !masterByServer) {
    return null;
  }
  try {
    const key = await webcrypto.subtle.importKey(
      "pkcs8",
      unb64(keypair.private_key),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    return Buffer.from(
      await webcrypto.subtle.decrypt({ name: "RSA-OAEP" }, key, unb64(masterByServer)),
    );
  } catch {
    return null;
  }
};

const openWithMaster = async (master, iv, ciphertext) => {
  try {
    const key = await webcrypto.subtle.importKey(
      "raw",
      master,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    return Buffer.from(
      await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(iv) },
        key,
        unb64(ciphertext),
      ),
    );
  } catch {
    return null;
  }
};

/**
 * The board key, opened from whichever escrow row this run can reach.
 *
 * Every row for a board holds the SAME key under a different account's master,
 * so any one that opens is as good as another. Two ways in, tried in order:
 * the server's own copy, and — for an account that predates ADR 0011 and has
 * no server copy — a password supplied with `--as`.
 */
const boardKeyFor = async (boardId) => {
  const donors = db
    .prepare(
      `SELECT k.user_id, k.iv, k.ciphertext,
              a.master_by_server, a.master_by_password, a.master_by_password_iv,
              a.kdf_salt, a.kdf_iterations, u.username_display AS username
         FROM board_keys k
         JOIN account_keys a ON a.user_id = k.user_id
         JOIN users u ON u.id = k.user_id
        WHERE k.board_id = ?`,
    )
    .all(boardId);

  for (const donor of donors) {
    const master = donor.master_by_server
      ? await openMaster(donor.master_by_server)
      : passwords.has(donor.username)
      ? await openMasterByPassword(donor, passwords.get(donor.username))
      : null;

    if (!master) {
      continue;
    }
    try {
      const raw = await openWithMaster(master, donor.iv, donor.ciphertext);
      if (raw) {
        return raw.toString("utf8");
      }
    } finally {
      master.fill(0);
    }
  }
  return null;
};

/** The scene itself: AES-GCM under the board key, with a raw-bytes IV. */
const openScene = async (boardKey, iv, ciphertext) => {
  try {
    // The board key is a base64url JWK `k`, exactly as the browser minted it.
    const key = await webcrypto.subtle.importKey(
      "jwk",
      { alg: "A128GCM", ext: true, k: boardKey, key_ops: ["encrypt", "decrypt"], kty: "oct" },
      { name: "AES-GCM", length: 128 },
      false,
      ["decrypt"],
    );
    return Buffer.from(
      await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
    );
  } catch {
    return null;
  }
};

/**
 * Every board key this run can open, regardless of which board it belongs to.
 *
 * **Because duplicating a board copies the ciphertext verbatim.** `POST
 * /boards/:id/duplicate` does not re-encrypt — it cannot, the server had no key
 * — so a copy is readable only under its *source's* key, and the two share one.
 * That is the same fact the old dashboard surfaced as a duplicate you could
 * never open; here it works in our favour, because a key recovered for the
 * source opens the copy as well.
 *
 * Trying every key against every stuck scene is safe and cheap: AES-GCM
 * authenticates, so a wrong key is a rejected tag rather than plausible
 * garbage, and there are a dozen of each at most.
 */
const recoverableKeys = async () => {
  const found = new Map();
  const rows = db
    .prepare(
      `SELECT DISTINCT k.board_id FROM board_keys k`,
    )
    .all();
  for (const { board_id: boardId } of rows) {
    const key = await boardKeyFor(boardId);
    if (key) {
      found.set(boardId, key);
    }
  }
  return found;
};

const rows = db
  .prepare(
    `SELECT s.board_id, s.iv, s.ciphertext, s.byte_size,
            b.name, b.deleted_at, u.username_display AS owner
       FROM board_scenes s
       JOIN boards b ON b.id = s.board_id
       LEFT JOIN users u ON u.id = b.owner_id
      WHERE LENGTH(s.iv) > 0
      ORDER BY b.deleted_at IS NOT NULL, b.name`,
  )
  .all();

const update = apply
  ? db.prepare(
      "UPDATE board_scenes SET iv = ?, ciphertext = ?, byte_size = ? WHERE board_id = ?",
    )
  : null;

/**
 * An AES-GCM ciphertext is the plaintext plus a 16-byte authentication tag, so
 * an 18-byte scene decrypts to exactly 2 bytes — and the only 2-byte document
 * a scene serialises to is `[]`. Such a board is empty, and rewriting it as a
 * plaintext `[]` is therefore lossless *by arithmetic* rather than by
 * assumption: there is no content it could be hiding.
 *
 * Worth doing rather than leaving: these boards can otherwise only be cleared
 * by their owner opening them, and asking somebody to visit an empty board to
 * unblock a migration is a poor use of their afternoon. Four of the nine live
 * boards on this deployment were in exactly this state.
 */
const EMPTY_SCENE_BYTES = 16 + "[]".length;

const keyring = await recoverableKeys();
console.log(
  `lawha: ${keyring.size} board key(s) recoverable, and every one of them is` +
    ` tried against every scene — a duplicate shares its source's key\n`,
);

const converted = [];
const emptied = [];
const stuck = [];

for (const row of rows) {
  if (row.byte_size === EMPTY_SCENE_BYTES) {
    if (update) {
      const empty = Buffer.from("[]", "utf8");
      update.run(Buffer.alloc(0), empty, empty.byteLength, row.board_id);
    }
    emptied.push(row);
    continue;
  }

  const boardKey = await boardKeyFor(row.board_id);
  let plaintext = boardKey
    ? await openScene(boardKey, Buffer.from(row.iv), Buffer.from(row.ciphertext))
    : null;

  // Its own key did not open it. Try every other key we hold, because a
  // duplicated board shares its source's key — see `recoverableKeys`.
  if (!plaintext) {
    for (const [sourceId, candidate] of keyring) {
      if (sourceId === row.board_id) {
        continue;
      }
      plaintext = await openScene(
        candidate,
        Buffer.from(row.iv),
        Buffer.from(row.ciphertext),
      );
      if (plaintext) {
        row.viaDuplicateOf = sourceId;
        break;
      }
    }
  }

  if (!plaintext) {
    stuck.push(row);
    continue;
  }

  // Parsed before it is written. A decrypt that "succeeds" into something that
  // is not a scene would replace a readable row with an unreadable one, and
  // AES-GCM authenticating the tag is not the same as the plaintext being JSON.
  try {
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("not an element array");
    }
  } catch (error) {
    stuck.push({ ...row, reason: `decrypted to something unusable: ${error.message}` });
    continue;
  }

  if (update) {
    update.run(Buffer.alloc(0), plaintext, plaintext.byteLength, row.board_id);
  }
  converted.push(row);
}

const label = (row) =>
  `${row.board_id}  ${String(row.owner ?? "?").padEnd(14)} ${JSON.stringify(
    row.name ?? "",
  ).padEnd(30)} ${String(row.byte_size).padStart(8)}B${
    row.deleted_at ? "  (deleted)" : ""
  }`;

console.log(`lawha: ${dbPath}`);
console.log(`lawha: ${apply ? "APPLYING" : "dry run — pass --apply to write"}`);
console.log(`lawha: ${rows.length} scene(s) still stored encrypted\n`);

console.log(`converted by decrypting: ${converted.length}`);
for (const row of converted) {
  console.log(
    `   ${label(row)}${
      row.viaDuplicateOf ? `  — via the key of ${row.viaDuplicateOf}` : ""
    }`,
  );
}

console.log(
  `\nconverted as provably empty: ${emptied.length}` +
    ` (an ${EMPTY_SCENE_BYTES}-byte ciphertext is 2 bytes of plaintext, i.e. "[]")`,
);
for (const row of emptied) {
  console.log(`   ${label(row)}`);
}

console.log(`\nNOT convertible from the server: ${stuck.length}`);
for (const row of stuck) {
  console.log(`   ${label(row)}${row.reason ? `  — ${row.reason}` : ""}`);
}

const stuckLive = stuck.filter((row) => !row.deleted_at);
const stuckDeleted = stuck.length - stuckLive.length;
if (stuckDeleted) {
  console.log(
    `\nlawha: ${stuckDeleted} of those are on DELETED boards. They are not in\n` +
      `       anybody's way and nobody will open them to convert them, so they\n` +
      `       will still be here when the live count reaches zero. Decide about\n` +
      `       them deliberately rather than letting them block the gate.`,
  );
}

if (stuck.length) {
  console.log(
    `\nlawha: these hold no escrow row this server can open, so their keys are\n` +
      `       only in the browser that made them. They convert themselves the\n` +
      `       next time somebody opens them — nothing else is needed, and\n` +
      `       nothing here can be deleted until this count reaches zero.`,
  );
}

const remaining = db
  .prepare("SELECT COUNT(*) AS n FROM board_scenes WHERE LENGTH(iv) > 0")
  .get().n;
const remainingLive = db
  .prepare(
    `SELECT COUNT(*) AS n FROM board_scenes s
       JOIN boards b ON b.id = s.board_id
      WHERE LENGTH(s.iv) > 0 AND b.deleted_at IS NULL`,
  )
  .get().n;

console.log(
  `\nlawha: ${remaining} scene(s) encrypted after this run` +
    ` (${remainingLive} on live boards)`,
);

// Non-zero exit while any LIVE board is still encrypted, so this is usable as
// the gate it is. Deleted boards are counted and printed but do not hold the
// gate: nobody will ever open one to convert it, so gating on them would mean
// gating forever.
process.exit(remainingLive === 0 ? 0 : 1);
