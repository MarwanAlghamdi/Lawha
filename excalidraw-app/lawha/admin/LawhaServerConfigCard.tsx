import { useEffect, useState } from "react";

import { fetchAdminConfig } from "../auth/authApi";

import type { LawhaAdminConfig } from "../auth/authApi";

/**
 * Yes/No rather than a tick or a coloured dot.
 *
 * Every row here is a setting whose "on" is good in some deployments and bad in
 * others — `allowOpenRegistration` on a home server is convenient and on a
 * shared one is a hole — so painting them green and red would be the panel
 * asserting an opinion it does not have. It reports; the operator decides.
 */
const yesNo = (value: boolean) => (value ? "Yes" : "No");

interface Row {
  label: string;
  value: string;
  /** Mono, wrapping, for the two filesystem paths. */
  path?: boolean;
  hint?: string;
}

const rowsFor = (config: LawhaAdminConfig): Row[] => [
  {
    label: "Sign-in required",
    value: yesNo(config.requireAuth),
    hint: config.requireAuth
      ? "Visitors without an account are refused. Share links still work — a link visitor is a narrower principal, not an absent one."
      : "Visitors without an account share one anonymous identity.",
  },
  {
    label: "Open registration",
    value: yesNo(config.allowOpenRegistration),
    hint: config.allowOpenRegistration
      ? "Anyone who can reach Lawha can create an account."
      : "New accounts are created here, on this page, and nowhere else.",
  },
  /*
   * Which way round the requirement runs, because this row had it backwards.
   *
   * It used to read "Off. This matches a plain-HTTP origin, which Lawha cannot
   * really run on — board keys need a secure context." Both halves are dead:
   * board keys went with ADR 0012, and "Lawha needs a secure context" was
   * invariant 18, RETIRED by ADR 0018 when this deployment moved to plain HTTP
   * behind a gateway that owns port 80.
   *
   * Worse than merely stale. `LAWHA_SECURE_COOKIES=false` is what ADR 0018
   * *requires* here, and its replacement rule says why: a Secure cookie on a
   * plain-http origin is accepted by the browser, never stored, and signs
   * everyone out for ever with nothing in any log. So the one page an operator
   * opens to find out what the box is doing was telling them to go and turn on
   * the setting that takes the site down, and to distrust the setting that
   * keeps it up. Neither value is a fault on its own — which one is correct is
   * decided by the origin, and that is what the hints now say.
   *
   * AND SINCE ADR 0022 THERE IS A THIRD VALUE, which is why this row no longer
   * reads as a yes/no at all. `auto` decides per request from the scheme that
   * request arrived over, so the mode ALONE does not tell the reader what
   * happened to their own cookie — a deployment answering on both an http and
   * an https origin is doing two different things under one setting. The server
   * reports the mode and the resolved value, and this row says both. Printing
   * "Auto" by itself would leave a word on the page the operator has to go
   * somewhere else to look up, on the page that exists so they do not have to.
   */
  {
    label: "Secure cookies",
    value:
      config.secureCookies === "auto"
        ? `Auto — ${config.secureCookiesEffective ? "on" : "off"} here`
        : yesNo(config.secureCookies === "always"),
    hint:
      config.secureCookies === "auto"
        ? config.secureCookiesEffective
          ? "Following the scheme, and you reached this page over HTTPS, so the session cookie carries Secure. A visitor arriving over plain http gets it without, which is what keeps both origins working."
          : "Following the scheme, and you reached this page over plain http, so the session cookie is sent without Secure — as it must be, or the browser would accept it and never store it. The same server sets Secure for anyone arriving over HTTPS."
        : config.secureCookies === "always"
        ? "Pinned on: the session cookie is sent over HTTPS only. Correct behind TLS, and a silent lock-out on a plain http origin — the browser accepts the cookie and never stores it."
        : "Pinned off: the session cookie is sent over plain http too, and over HTTPS without the flag. Anyone who can watch the network can take a session. Consider `auto`, which gives the plain-http origin exactly this and adds Secure over HTTPS.",
  },
  {
    label: "Master password",
    // A boolean, and it stays a boolean. The server never reports the value or
    // its hash, and this row exists to say whether there is a way in at all —
    // not to hand anyone reading over a shoulder a credential.
    value: config.masterPasswordConfigured ? "Configured" : "Not set",
    hint: config.masterPasswordConfigured
      ? "Signs in as any account, from the ordinary sign-in screen, and every use is written to the server log."
      : "No master password is configured. A forgotten password is recovered from this page or from the reset-password command.",
  },
  {
    label: "Session length",
    // 0 is not a zero-length session. It is LAWHA_SESSION_TTL_DAYS=0, the
    // server's "never expires" setting, and it is the default. Rendering the
    // number would print "0 days" on the one page an operator opens precisely
    // to find out what the box is doing — which reads as a broken server or a
    // misconfiguration, and would send them to change a setting that is already
    // correct.
    value:
      config.sessionTtlDays === 0
        ? "Never expires"
        : `${config.sessionTtlDays} day${
            config.sessionTtlDays === 1 ? "" : "s"
          }`,
    // Said out loud because "never" is a server-side promise that the browser
    // does not keep: Chrome and Safari cap a cookie at about 400 days whatever
    // Max-Age is sent, so the session row is immortal and the cookie is not.
    // Somebody who uses Lawha never signs in again; somebody who disappears for
    // over a year does, once, and that is not a bug worth investigating.
    hint:
      config.sessionTtlDays === 0
        ? "Sessions do not expire. The browser cookie still cannot outlive about 400 days, so it is re-issued as people keep visiting — only an absence of more than a year means signing in again. Logout, a password change and this panel all revoke immediately."
        : "Refreshed rolling in its last day, so an active session does not end mid-drawing. Set LAWHA_SESSION_TTL_DAYS=0 for sessions that never expire.",
  },
  {
    label: "Trash",
    // Same 0-handling as the session TTL above, and for a sharper reason: this
    // is the setting that decides whether a deleted board is ever irreversibly
    // destroyed, so "0 days" printed here would read as "destroyed
    // immediately" when it means the exact opposite.
    value:
      config.trashRetentionDays === 0
        ? "Kept for ever"
        : `${config.trashRetentionDays} day${
            config.trashRetentionDays === 1 ? "" : "s"
          }`,
    hint:
      config.trashRetentionDays === 0
        ? "Deleted boards stay in the trash until somebody empties it. Nothing is removed on a timer. Set LAWHA_TRASH_RETENTION_DAYS to a number of days to sweep them."
        : "A deleted board is restorable from the owner's trash until this many days have passed, then it is destroyed — row, scene and uploaded images. Set LAWHA_TRASH_RETENTION_DAYS=0 to keep them indefinitely.",
  },
  {
    label: "Database",
    value: config.dbPath,
    path: true,
    // The advice this hint used to give — "stop the server, or copy the -wal
    // and -shm alongside it" — is how the last database was lost, in a
    // different costume. Copying the three files is not safe either: a `tar` or
    // `cp` can catch the `-wal` mid-transaction and archive one that disagrees
    // with its `.db`, which restores in silence and comes back short. The
    // supported answer is the online backup API, which needs no downtime and
    // emits one checkpointed file, and it is named here because a person
    // reading this row is a person about to take a backup.
    hint: "SQLite in WAL mode: copying this file alone yields a database with NO tables, and copying all three can catch the -wal mid-write. Use `yarn --cwd lawha-server backup <dir>` — no downtime, one verified file. See the README.",
  },
  { label: "Files", value: config.filesDir, path: true },
  {
    label: "Accounts",
    value: `${config.userCount} (${config.adminCount} administrator${
      config.adminCount === 1 ? "" : "s"
    })`,
  },
];

/**
 * `GET /api/admin/config`, on screen at last.
 *
 * The endpoint has existed since Phase 5 with no caller — roadmap known issue
 * 19 — which meant self-hosting still involved reading `src/config.ts` to find
 * out what the box was doing, or `docker compose exec` to find out where the
 * database was. Both of those are answers the running server already had.
 *
 * A failure here is reported and nothing else: this card is a description, and
 * the recovery controls below it must stay usable when it cannot load. They are
 * separate requests to separate routes and one going down is not a reason to
 * take the other off screen.
 */
export const LawhaServerConfigCard = () => {
  const [config, setConfig] = useState<LawhaAdminConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchAdminConfig()
      .then((loaded) => {
        if (live) {
          setConfig(loaded);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (live) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not read the server configuration.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="lw-card lw-server-config">
      <div className="lw-section">
        <span className="lw-section__title">Deployment</span>
        <span className="lw-section__caption">
          What it is actually doing, read from the running process rather than
          from a config file someone may have edited since it started.
        </span>
      </div>

      {error ? (
        <p className="lw-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {config === null && !error ? (
        <span className="lw-field__hint">Reading configuration…</span>
      ) : null}

      {config !== null ? (
        <dl className="lw-server-config__list">
          {rowsFor(config).map((row) => (
            <div className="lw-server-config__row" key={row.label}>
              <dt className="lw-server-config__label">{row.label}</dt>
              <dd className="lw-server-config__value">
                <span
                  className={
                    row.path
                      ? "lw-server-config__path"
                      : "lw-server-config__plain"
                  }
                >
                  {row.value}
                </span>
                {row.hint ? (
                  <span className="lw-field__hint">{row.hint}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
};
