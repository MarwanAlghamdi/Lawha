import fs from "node:fs";
import crypto from "node:crypto";

/**
 * A one-shot claim on a backup download.
 *
 * The problem it solves is narrow and entirely about how browsers download.
 * The step-up password has to travel in a POST body — it cannot go in a URL
 * that lands in history and access logs — but a POST cannot produce a native
 * "save to disk" download. Reading the response with `fetch` and building an
 * object URL would work and would also hold the entire archive in the tab's
 * memory, which for a deployment of any size is how you kill the browser.
 *
 * So: POST proves who is asking, and hands back a ticket. A plain GET redeems
 * it, streams to disk the way the browser is good at, and the ticket dies on
 * first use. The secret in the URL is worth one download, for sixty seconds,
 * to the session that asked for it.
 *
 * In memory, not in the database, for the same reason `RateLimiter` is: this
 * is a single-node self-hosted service. A restart voiding outstanding tickets
 * costs an admin one extra click; a table costs a migration and a cleanup job
 * to hold state that is meaningless ninety seconds after it is written.
 */

export type BackupTicketKind = "snapshot" | "archive";

export interface BackupTicket {
  kind: BackupTicketKind;
  /**
   * Who may redeem it. `u:<userId>` for an account session, or
   * `admin:<adminSessionToken>` for a master-password session — the SPECIFIC
   * browser session, not the IP, so a second master session on the same LAN
   * cannot collect someone else's download.
   */
  ownerKey: string;
  /** Absolute path of the temp snapshot. Snapshot tickets only. */
  snapshotPath?: string;
  /** Archive filename, already validated against BACKUP_NAME. Archive tickets only. */
  archiveEntryId?: string;
  expiresAt: number;
}

/**
 * Sixty seconds. The gap between "the POST returned" and "the browser issued
 * the GET" is one `location` assignment — a few milliseconds. A minute is
 * generous enough to survive a slow tab and short enough that a leaked URL in
 * a screen share is worthless by the time anyone reads it back.
 */
const TICKET_TTL_MS = 60_000;

const SWEEP_INTERVAL_MS = 30_000;

export interface BackupTicketStore {
  issue: (ticket: Omit<BackupTicket, "expiresAt">) => {
    ticketId: string;
    expiresAt: number;
  };
  /**
   * Redeem and destroy in one step. Returns undefined if the ticket is unknown,
   * expired, already spent, or belongs to a different session — deliberately
   * ONE outcome for all four, so a caller cannot accidentally tell an attacker
   * which of them it was.
   */
  redeem: (ticketId: string, ownerKey: string) => BackupTicket | undefined;
  /** For tests and shutdown: stop the sweep timer. */
  stop: () => void;
}

export const createBackupTicketStore = (): BackupTicketStore => {
  const tickets = new Map<string, BackupTicket>();

  /**
   * Every file SQLite can leave beside an abandoned snapshot, not just the
   * snapshot itself — mirrors `SnapshotTaker.release` in `backupSnapshot.ts`.
   */
  const SNAPSHOT_SIDECARS = ["", "-wal", "-shm", "-journal"];

  /**
   * Deleting the ticket is not enough — an unredeemed snapshot ticket owns a
   * full copy of the database sitting in the data directory. Dropping the map
   * entry without unlinking every one of `SNAPSHOT_SIDECARS` would leak a
   * whole database per abandoned download, and the disk that fills is the one
   * the live database is on.
   *
   * Used to be one `fs.rm(snapshotPath, { force: true }, () => {})` call,
   * which was worse in two ways at once: the empty callback discarded
   * whatever the removal actually failed with, and a bare snapshot path never
   * reached the `-wal`/`-shm`/`-journal` a `VACUUM INTO` snapshot can leave
   * beside it (see `backupSnapshot.ts`'s own header comment for the
   * measurement) — those sidecars were never swept at all.
   */
  const discard = (ticket: BackupTicket) => {
    if (ticket.kind !== "snapshot" || !ticket.snapshotPath) {
      return;
    }

    for (const suffix of SNAPSHOT_SIDECARS) {
      try {
        fs.rmSync(`${ticket.snapshotPath}${suffix}`, { force: true });
      } catch {
        // Already gone, or the directory went with it. Each gets its own
        // `try` because `{ force: true }` suppresses ENOENT and not ENOTDIR,
        // and one failing name must not stop the other three being removed.
      }
    }
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt <= now) {
        tickets.delete(id);
        discard(ticket);
      }
    }
  };

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Never hold the process open for a cleanup pass. Exiting drops the temp
  // files anyway — they are all under the data directory and named for it.
  timer.unref();

  return {
    issue: (ticket) => {
      const ticketId = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + TICKET_TTL_MS;
      tickets.set(ticketId, { ...ticket, expiresAt });
      return { ticketId, expiresAt };
    },

    redeem: (ticketId, ownerKey) => {
      const ticket = tickets.get(ticketId);

      if (!ticket) {
        return undefined;
      }

      // Spent on lookup, whatever happens next. A ticket that fails the owner
      // check is still burned: retrying it with a different session is exactly
      // the thing worth refusing.
      tickets.delete(ticketId);

      if (ticket.expiresAt <= Date.now() || ticket.ownerKey !== ownerKey) {
        discard(ticket);
        return undefined;
      }

      return ticket;
    },

    stop: () => {
      clearInterval(timer);
      for (const ticket of tickets.values()) {
        discard(ticket);
      }
      tickets.clear();
    },
  };
};
