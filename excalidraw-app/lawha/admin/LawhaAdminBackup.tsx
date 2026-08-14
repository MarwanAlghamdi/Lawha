import { useCallback, useEffect, useState } from "react";

import {
  backupDownloadUrl,
  fetchBackupArchive,
  fetchBackupStatus,
  requestBackupArchiveTicket,
  requestBackupSnapshot,
} from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";

import { LawhaAdminBackupPrompt } from "./LawhaAdminBackupPrompt";

import type {
  LawhaBackupArchiveEntry,
  LawhaBackupStatus,
  LawhaBackupTicket,
} from "../auth/authApi";

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const formatWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A span of time in the largest unit that still reads as a quantity.
 *
 * "604800000 ms" and "168 hours" are both the truth and neither is a thing an
 * operator can react to; "7 days" is. The cut at two days rather than one is
 * so that a schedule running every 24 or 36 hours states its own limit in the
 * unit it was configured in — a "25 hours" threshold rendered as "1 day" would
 * no longer be recognisably `LAWHA_BACKUP_INTERVAL_HOURS` plus the grace.
 */
const formatDuration = (ms: number): string => {
  if (ms < HOUR_MS) {
    // Never "0 minutes". A span short enough to round to nothing is still a
    // span, and this only ever renders for something already judged late.
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 2 * DAY_MS) {
    const hours = Math.round(ms / HOUR_MS);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/**
 * How the scheduler's own words become a sentence.
 *
 * The state strings come from `docker/lawha-backup.sh`, which writes them into
 * `.lawha-backup-status` every cycle and reads them back for its own
 * HEALTHCHECK. Reporting them rather than recomputing anything is the point:
 * `docker compose ps` and this card cannot disagree about whether backups are
 * healthy, because there is one writer.
 *
 * **Each of these is a sentence about the LAST COMPLETED CYCLE, not about
 * now**, and that distinction was invisible until it was wrong: "Running
 * normally." sat on this card for a week-old `status=ok` while the same file's
 * age had already failed the container's own healthcheck. One writer and two
 * readers guarantees nothing if the readers apply different rules — so the age
 * rule now arrives beside the status as `overdue`, and is rendered ABOVE this
 * line rather than in place of it. Do not fold the two together: the last
 * cycle genuinely did succeed, and an operator who cannot tell a stalled
 * scheduler from a failed backup is looking at two different incidents through
 * one sentence.
 */
const STATUS_SENTENCE: Record<string, string> = {
  ok: "Running normally.",
  waiting: "Waiting — there is no database to back up yet.",
  failed: "The last backup FAILED. Check `docker compose logs lawha-backup`.",
  disabled: "Turned off — LAWHA_BACKUP_INTERVAL_HOURS is 0.",
};

/**
 * Start a download without leaving the page.
 *
 * A hidden iframe rather than `window.location.assign`. The response is either
 * a tar with `Content-Disposition: attachment` — which the browser hands to its
 * download manager without navigating, from a frame or from the top level
 * alike — or a JSON error, if the ticket expired in the seconds between being
 * issued and being redeemed. On the top level that JSON *replaces the admin
 * page*, which is a spectacular way to report "your link expired". In a frame
 * nobody can see, it goes nowhere and the page stays put.
 *
 * The frame is removed on a timer rather than on load: a download does not
 * fire `load` in every browser, and removing the element mid-transfer cancels
 * it. Ten minutes is far longer than any transfer needs and the element costs
 * nothing while it waits.
 */
const startDownload = (ticketId: string) => {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = backupDownloadUrl(ticketId);
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 10 * 60 * 1000);
};

/** Which prompt is open, if any. `null` for the fresh-snapshot one. */
type Pending = { entryId: string | null };

/**
 * Backups, on the administration page.
 *
 * Read-only about the schedule and active about everything else, and the split
 * is deliberate. Interval and retention live in `lawha.env` with every other
 * operator knob, and an admin page that could change them would need shared
 * state between this process and a container that reads its settings once at
 * startup — a lot of machinery to move two numbers out of the file where an
 * operator already expects to find them.
 *
 * What this page adds is the two things a file cannot do: take a backup right
 * now, and get one off the box. Note that "back up now" does NOT write to the
 * archive — the archive belongs to the `lawha-backup` container and this
 * process only ever sees it read-only. A forced backup is a fresh verified
 * copy made for downloading and deleted afterwards; it does not join the
 * retained rotation and does not reset the schedule.
 */
export const LawhaAdminBackup = () => {
  const { masterAdmin } = useLawhaSession();

  const [status, setStatus] = useState<LawhaBackupStatus | null>(null);
  const [entries, setEntries] = useState<LawhaBackupArchiveEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const loadArchive = useCallback(() => {
    fetchBackupArchive()
      .then(setEntries)
      .catch(() => {
        // A 404 here is the ordinary answer for a deployment with no archive
        // mounted — `yarn dev`, or a stack without the backup container. The
        // status block above already says so in words; a second red line
        // saying "not found" would read as a fault.
        setEntries([]);
      });
  }, []);

  useEffect(() => {
    let live = true;

    fetchBackupStatus()
      .then((loaded) => {
        if (live) {
          setStatus(loaded);
        }
      })
      .catch((caught: unknown) => {
        if (live) {
          setError(messageOf(caught, "Could not read the backup status."));
        }
      });

    loadArchive();

    return () => {
      live = false;
    };
  }, [loadArchive]);

  const run = async (password: string) => {
    const entryId = pending?.entryId ?? null;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const ticket: LawhaBackupTicket = entryId
        ? await requestBackupArchiveTicket(entryId, password)
        : await requestBackupSnapshot(password);

      startDownload(ticket.ticketId);
      setPending(null);
      setNotice(
        entryId
          ? `${entryId} is downloading.`
          : `A new backup was taken${
              ticket.sizeBytes ? ` (${formatBytes(ticket.sizeBytes)})` : ""
            } and is downloading. It was not added to the archive.`,
      );
    } catch (caught: unknown) {
      setError(messageOf(caught, "The backup could not be prepared."));
    } finally {
      setBusy(false);
    }
  };

  const scheduleLine =
    status?.intervalHours && status.keep
      ? `Every ${status.intervalHours} hour${
          status.intervalHours === 1 ? "" : "s"
        } · keeping ${status.keep}`
      : null;

  /**
   * How far past its own deadline the scheduler is, or null when it is not.
   *
   * `status.overdue` is the whole of the decision — read from the server and
   * never recomputed here, because `readBackupStatus` deliberately declines to
   * judge `disabled`, `failed`, and a status file that carries no
   * `interval_hours`, and a card that guessed in those cases would recreate
   * the exact disagreement this closes with the sign flipped. The two null
   * guards below are belt and braces for a payload that says `overdue` while
   * withholding what it was measured from.
   */
  const overdueBy =
    status?.overdue && status.at !== null ? Date.now() - status.at : null;

  return (
    <div className="lw-card lw-backup">
      <div className="lw-section">
        <span className="lw-section__title">Backups</span>
        <span className="lw-section__caption">
          Taken on a schedule by a separate container, which is the only thing
          that may write to the archive. Interval and retention are set in
          lawha.env.
        </span>
      </div>

      {error ? (
        <p className="lw-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="lw-backup__notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="lw-backup__status">
        {status === null && !error ? (
          <span className="lw-field__hint">Reading backup status…</span>
        ) : null}

        {status !== null && !status.configured ? (
          <span className="lw-field__hint">
            No backup archive is mounted on this server, so there is nothing
            scheduled and nothing to list. You can still take one below and
            download it.
          </span>
        ) : null}

        {status?.configured ? (
          <>
            {scheduleLine ? (
              <span className="lw-backup__schedule">{scheduleLine}</span>
            ) : null}

            {/*
              Above the status sentence, and loud.

              This is the half of the card that used to be missing entirely:
              the raw timestamp and the interval were both already on screen,
              so the data was here and only the judgement was not — and an
              operator reading "Running normally. / Last backup Aug 5" has been
              handed everything they need to work out that backups stopped a
              week ago, and no reason to do the arithmetic.

              It names the limit rather than merely asserting lateness, so the
              claim is checkable against `LAWHA_BACKUP_INTERVAL_HOURS` without
              leaving the page, and it says which of the two lines is about
              now — otherwise "Running normally." directly underneath reads as
              a contradiction rather than as the last cycle's own verdict.
            */}
            {overdueBy !== null ? (
              <p className="lw-backup__stale" role="alert">
                <strong>
                  Nothing has been backed up for {formatDuration(overdueBy)}.
                </strong>{" "}
                {status.overdueAfterMs !== null
                  ? `That is past the ${formatDuration(
                      status.overdueAfterMs,
                    )} this schedule allows, so the scheduler has stalled — `
                  : "The scheduler has stalled — "}
                a container that was stopped, or one wedged on a backup that
                never finished. `docker compose ps` is already calling it
                unhealthy for the same reason. The line below is the last cycle
                it managed to complete, not what is happening now.
              </p>
            ) : null}

            <span className="lw-backup__state" data-status={status.status}>
              {status.status
                ? STATUS_SENTENCE[status.status] ?? status.status
                : "Waiting for the first backup cycle."}
            </span>
            {status.at ? (
              <span className="lw-field__hint">
                Last backup {formatWhen(status.at)}
                {status.detail ? ` · ${status.detail}` : ""}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {pending && pending.entryId === null ? (
        <LawhaAdminBackupPrompt
          what="A backup of this server"
          masterOnly={masterAdmin === true}
          // This snapshot is taken and streamed by THIS process, on demand
          // (`backupSnapshot.ts`) — a separate code path from the scheduled
          // archive below, and one that does not route through `age` at all,
          // whether or not LAWHA_BACKUP_RECIPIENT is configured. Claiming it
          // needs a key it does not would be exactly the same failure this
          // task exists to close, aimed the other way: an operator trusting
          // a plaintext file to be protected because everything else on this
          // page is.
          encrypted={false}
          // Unlike `encrypted` above, this one is NOT structurally false: the
          // snapshot is copied out of the live database, so it is SQLCipher
          // exactly when the live database is.
          databaseKeyed={status?.databaseEncrypted === true}
          busy={busy}
          onSubmit={run}
          onCancel={() => setPending(null)}
        />
      ) : (
        <div className="lw-actions">
          <button
            type="button"
            className="lw-btn"
            disabled={busy}
            onClick={() => {
              setNotice(null);
              setError(null);
              setPending({ entryId: null });
            }}
          >
            Back up now and download
          </button>
        </div>
      )}
      <span className="lw-field__hint">
        {status?.databaseEncrypted === true
          ? // The sentence this replaced said the download was "in plain
            // form", which stopped being true the moment a snapshot started
            // being copied out of a SQLCipher database — an affirmatively
            // wrong claim about a file somebody is about to rely on, not
            // merely a missing one.
            "This on-demand copy does not go through the age encryption configured for the scheduled archive below — but the database inside it is encrypted with LAWHA_DB_KEY, the same value this server boots with, and cannot be opened without it."
          : "Downloaded as-is, in plain form — this on-demand copy is not affected by any backup encryption configured for the scheduled archive below."}
      </span>

      {entries.length > 0 ? (
        <>
          <span className="lw-field__hint">
            Scheduled backups on this server. Downloading one bundles it with
            the uploaded images kept alongside it.
          </span>
          <ul className="lw-backup__archive">
            {entries.map((entry) => {
              // `entry.needsPrivateKey` comes from the server
              // (`backupArchive.ts`), not from `entry.id.endsWith(".db.age")`
              // — review found that check unsafe in the direction that
              // matters. Every entry in this archive downloads bundled with
              // the SAME shared blob mirror (`resolveArchiveBlobsDir`), so
              // the moment that mirror holds even one `.age` blob, an older
              // PLAINTEXT `.db` entry's own download carries ciphertext its
              // id gives no hint of. The id alone is only ever right about
              // this entry's own database file, never about what it ships
              // bundled with.
              const encrypted = entry.needsPrivateKey;
              // The `age` layer and the SQLCipher one are independent, and an
              // entry can need one, the other, both or neither — a keyed
              // deployment that never set LAWHA_BACKUP_RECIPIENT listed every
              // entry with no badge at all before this, because the only flag
              // there was the age one.
              const databaseKeyed = entry.needsDatabaseKey;

              return (
                <li
                  className="lw-backup__entry"
                  key={entry.id}
                  data-testid={`backup-entry-${entry.id}`}
                >
                  <div className="lw-backup__entry-head">
                    <span className="lw-backup__entry-name">{entry.id}</span>
                    <span className="lw-backup__entry-meta">
                      {formatWhen(entry.takenAtMs)} ·{" "}
                      {formatBytes(entry.sizeBytes)}
                    </span>
                    {encrypted || databaseKeyed ? (
                      <span className="lw-backup__entry-encrypted">
                        {encrypted && databaseKeyed
                          ? "Encrypted — needs the private key AND LAWHA_DB_KEY to open"
                          : encrypted
                          ? "Encrypted — needs the private key to open"
                          : "Encrypted — needs LAWHA_DB_KEY to open"}
                      </span>
                    ) : null}
                  </div>

                  {pending?.entryId === entry.id ? (
                    <LawhaAdminBackupPrompt
                      what={entry.id}
                      masterOnly={masterAdmin === true}
                      encrypted={encrypted}
                      databaseKeyed={databaseKeyed}
                      busy={busy}
                      onSubmit={run}
                      onCancel={() => setPending(null)}
                    />
                  ) : (
                    <div className="lw-actions">
                      <button
                        type="button"
                        className="lw-btn"
                        disabled={busy}
                        onClick={() => {
                          setNotice(null);
                          setError(null);
                          setPending({ entryId: entry.id });
                        }}
                      >
                        Download
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
};
