import { useEffect, useState } from "react";

import { fetchAdminAudit } from "../auth/authApi";

import type { LawhaAuditEntry } from "../auth/authApi";

/**
 * What has been done here, and by whom. See ADR 0015.
 *
 * Administrative actions were logged to stdout and nowhere else — a real
 * record, but only for somebody with a shell on the box and the patience to
 * grep a container's output, and gone the moment the log rotates. What it
 * records is not: an `is_admin` row outlives the session that wrote it,
 * survives a password rotation, and is invisible from every screen the
 * account's owner ever looks at.
 *
 * Read-only, and there is no control here or anywhere else that deletes from
 * it. A log with an erase button is not evidence.
 */

/**
 * One sentence per action, in the past tense, naming the target.
 *
 * A lookup rather than string assembly because these are the sentences a
 * person reads to work out what happened, and "admin.granted yasmin" is not
 * one. Keyed on the server's closed set of action strings, so a new action
 * that nobody adds a sentence for renders as its raw name — visible, rather
 * than silently absent.
 */
const SENTENCES: Record<string, (target: string) => string> = {
  /**
   * Nothing writes these two any more — `POST /admin/users/:id/password` was
   * removed outright, not unlinked. They stay because `admin_audit` has no
   * delete (ADR 0015), so every row an administrator produced with them is
   * still in the database and still the most sensitive thing in this log:
   * somebody else once knew that account's password. Dropping the sentences
   * with the route would render exactly those rows as `password.generated`.
   */
  "password.set": (target) => `set ${target}'s password`,
  "password.generated": (target) => `generated a new password for ${target}`,
  "password.reset.issued": (target) =>
    `issued a password reset code for ${target}`,
  /**
   * The only row in this log whose actor is not an administrator.
   *
   * `actorLabel` is the account holder's own username, and `target` is the
   * same person — so the sentence deliberately reads in the first person
   * rather than naming them twice ("**yasmin** set their own password" and
   * not "yasmin set yasmin's password"). That is the whole point of the
   * feature: this is the line the product could not write while an
   * administrator was the one choosing the password.
   */
  "password.reset.redeemed": () => "set their own password with a reset code",
  "sessions.revoked": (target) => `signed ${target} out everywhere`,
  "admin.granted": (target) => `made ${target} an administrator`,
  "admin.revoked": (target) => `removed ${target}'s administrator role`,
  "account.created": (target) => `created the account ${target}`,
  "account.disabled": (target) => `turned ${target} off`,
  "account.enabled": (target) => `turned ${target} back on`,
  // The one entry here whose target is not an account. It reads naturally
  // either way because the server sends a phrase rather than a name — "a
  // backup taken just now", or the archived file's own name.
  "backup.downloaded": (target) => `downloaded ${target}`,
};

const describe = (entry: LawhaAuditEntry): string => {
  const target = entry.targetLabel ?? "an account";
  return SENTENCES[entry.action]?.(target) ?? `${entry.action} · ${target}`;
};

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const LawhaAdminAudit = () => {
  const [entries, setEntries] = useState<LawhaAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminAudit()
      .then(setEntries)
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error ? caught.message : "Could not load the log.",
        ),
      );
  }, []);

  return (
    <div className="lw-card lw-admin-log">
      <div className="lw-section">
        <span className="lw-section__title">What has been done here</span>
        <span className="lw-section__caption">
          Every administrative action, newest first. Nothing on this page can
          remove an entry.
        </span>
      </div>

      {error ? (
        <p className="lw-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {entries !== null && entries.length === 0 ? (
        <span className="lw-field__hint">Nothing yet.</span>
      ) : null}

      {entries !== null && entries.length > 0 ? (
        <ol className="lw-admin-log__list">
          {entries.map((entry) => (
            <li key={entry.id} className="lw-admin-log__item">
              <span className="lw-admin-log__what">
                <strong>{entry.actorLabel}</strong> {describe(entry)}
              </span>
              <span className="lw-admin-log__meta">
                {when(entry.at)}
                {entry.detail ? ` · ${entry.detail}` : ""}
                {/*
                  Marked, not hidden. A master-password session has nobody
                  behind it (migration 007), so the log can say what was done
                  and that the administration password did it, and cannot say
                  which person was holding it. That cost is worth stating on
                  the row rather than leaving a reader to assume the named
                  actor was a person.
                */}
                {entry.viaMaster ? " · via the master password" : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
};
