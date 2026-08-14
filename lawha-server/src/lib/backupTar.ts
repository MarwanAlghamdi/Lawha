import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import * as tar from "tar";

import type { Response } from "express";

/**
 * One archive an operator can actually restore a deployment from.
 *
 * A verified database alone is not that. `backup.mjs` says so on every run —
 * "uploaded blobs are not in this file" — and it is right to leave them out,
 * because the blobs are content-addressed and belong in an append-only mirror
 * rather than inside every nightly snapshot. But a human clicking Download on
 * an admin page means "give me the thing that restores this", and handing them
 * half of it with a note attached is how a restore fails at the worst moment.
 *
 * So this streams both, as ONE tar: the database at the root, blobs under
 * `files/`.
 *
 * ON TARRING A `.db` AT ALL — see the long note in backupSnapshot.ts. Short
 * version: what reaches here is never the live WAL database, always a verified
 * copy with `journal_mode = DELETE` already forced and no sidecars left. That
 * is the only kind of `.db` this function may be pointed at, and both callers
 * satisfy it. Do not add a third caller that passes `ctx.config.dbPath`.
 *
 * ON ENCRYPTION — this function has none, and does not need any. `dbPath` may
 * already be `age` ciphertext (an archived entry ending `.db.age`, once
 * LAWHA_BACKUP_RECIPIENT is configured — see `backupVerify.ts`'s
 * `AGE_BACKUP_NAME`), and `blobsDir` may already contain a mix of plaintext
 * and `.age`-suffixed blobs (`docker/lawha-backup.sh`'s `mirror_blobs`). This
 * function tars whatever bytes it is handed, unmodified, under whatever name
 * they already carry — it is a courier, not a cryptographic boundary, and
 * that is deliberate: the ON-DEMAND snapshot path (`backupSnapshot.ts`) never
 * encrypts its own artefact regardless of this setting, so a function here
 * that assumed "arriving via this path" meant "safe to treat as encrypted"
 * would be wrong for one of its two callers. Telling an operator whether the
 * archive they are about to download needs a private key is `/admin`'s job
 * (`LawhaAdminBackup.tsx`, at the point of download), not this file's.
 */

export interface BackupTarSource {
  /** A verified, sidecar-free database. NEVER the live one. */
  dbPath: string;
  /** What to call it inside the archive. */
  dbEntryName: string;
  /** Directory of uploaded blobs, or null to ship the database alone. */
  blobsDir: string | null;
  /**
   * A writable directory for the staging symlinks below. The data directory,
   * in practice — the archive mount is read-only and cannot host them.
   */
  workDir: string;
}

/**
 * WHY A STAGING DIRECTORY OF SYMLINKS, and not two tar streams end to end.
 *
 * The database and the blobs live under different parents in every case — a
 * snapshot in the data directory, an archived database in `/backups`, the
 * blobs somewhere else again — and tar's `cwd` is fixed for the life of one
 * `create` call. The obvious way out is to concatenate two tars into the same
 * response.
 *
 * That produces a file which LOOKS complete and silently is not. A tar ends
 * with two 512-byte zero blocks, so a concatenated pair has an end-of-archive
 * marker sitting in the middle of it, and every default reader stops there.
 * Measured, not assumed: `tar -tf` on a concatenated archive here listed the
 * database and nothing else, while `tar -itf` on the same bytes listed all of
 * it. An operator would extract that, see a database, and discover the missing
 * blobs on the day the boards came back without their images.
 *
 * So the two sources are made to share one parent first, by symlinking both
 * into a scratch directory, and `follow: true` walks through the links so the
 * targets' contents are what get archived. One tar, one end marker, everything
 * inside it, readable with no special flags.
 */
const withStagedSources = async <T>(
  source: BackupTarSource,
  run: (stageDir: string, entries: string[]) => Promise<T>,
): Promise<T> => {
  const stageDir = path.join(
    source.workDir,
    `.tar-stage-${crypto.randomBytes(8).toString("hex")}`,
  );

  await fs.promises.mkdir(stageDir, { recursive: true });

  try {
    const entries: string[] = [source.dbEntryName];

    await fs.promises.symlink(
      path.resolve(source.dbPath),
      path.join(stageDir, source.dbEntryName),
    );

    if (source.blobsDir && fs.existsSync(source.blobsDir)) {
      await fs.promises.symlink(
        path.resolve(source.blobsDir),
        path.join(stageDir, "files"),
      );
      entries.push("files");
    }

    return await run(stageDir, entries);
  } finally {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
  }
};

/**
 * Uncompressed, deliberately.
 *
 * The blobs are already-compressed images in the ordinary case, so gzip buys
 * little there, and it would put a CPU-bound compressor between the disk and a
 * LAN client that is not bandwidth-bound to begin with. `tar.create` takes
 * `gzip: true` if a deployment ever turns out to be shipping these over a slow
 * link.
 */
export const streamBackupTar = (
  res: Response,
  source: BackupTarSource,
): Promise<void> =>
  withStagedSources(source, (stageDir, entries) =>
    pipeline(
      tar.create(
        {
          cwd: stageDir,
          // The whole point of the staging directory: archive what the links
          // point at, not the links.
          follow: true,
          // Not `portable: true` — that zeroes mtimes for reproducible builds,
          // and here an mtime is information: it is when the backup was taken.
        },
        entries,
      ),
      res,
    ),
  );
