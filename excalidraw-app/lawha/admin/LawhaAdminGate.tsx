import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  LawhaApiError,
  signIn as signInRequest,
  signInWithMasterPassword,
} from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";
import { LawhaLogo } from "../chrome/LawhaLogo";
import { LawhaThemeToggle } from "../chrome/LawhaThemeToggle";
import { LawhaField } from "../pages/LawhaField";
import { LawhaPageShell } from "../pages/LawhaPageShell";
import { useAppTheme } from "../../useHandleAppTheme";

// The card's shell — border, padding, header row, error box, submit — is the
// sign-in card's, imported rather than reimplemented. Two screens that "look
// the same" drift the first time either is edited.
import "../auth/LawhaAuth.scss";

import "./LawhaAdmin.scss";

import type { LawhaUser } from "../auth/authApi";

/**
 * Whether a session may see `/admin`.
 *
 * Declared once and used twice — by `RequireAdmin`, which decides whether to
 * render the gate at all, and by the gate itself, which needs the same answer
 * to tell somebody that the account they just signed in as was not enough. Two
 * copies of this predicate is exactly the shape of duplication invariant 21
 * describes: they would agree until one of them was edited, and the one that
 * stayed behind would keep the screen looking correct.
 *
 * It mirrors the server's `requireAdmin` in
 * `lawha-server/src/http/routes/admin.ts`, which refuses on
 * `!req.user.isAdmin && req.viaMaster !== true`, plus the `req.masterAdmin`
 * short-circuit in front of it. `masterAdmin` is checked FIRST here for the
 * same reason it is there: that session has no user at all, so every
 * account-shaped test below would answer "no" to a caller who is entitled to
 * be here. This is a courtesy, never the control — every route behind it is
 * enforced again on the server.
 */
export const canReachAdmin = (
  user: LawhaUser | null,
  viaMaster: boolean,
  masterAdmin: boolean,
): boolean => masterAdmin || (user !== null && (user.isAdmin || viaMaster));

/** Which credential the password field is currently holding. */
type Credential = "account" | "master";

/**
 * The screen anyone who is not an administrator gets at `/admin`.
 *
 * **This page announces itself, and that is a reversal.** `/admin` used to be
 * unlisted in effect as well as in fact: a signed-out visitor was shown the
 * ordinary sign-in card, word for word, and a signed-in non-administrator was
 * `<Navigate to="/" replace />`d — indistinguishable from mistyping a URL, so
 * guessing the address told you nothing. See `docs/adr/0009` for why that was
 * spent. The short version is that a redirect with no explanation is also
 * indistinguishable from a bug, and it was reported as one.
 *
 * What did *not* change: the access control. `requireAdmin` on the server
 * refuses every route behind this regardless of what the client renders, and
 * nothing here is a page unlock.
 *
 * **The master segment asks for the password and nothing else, and it is still
 * not a page unlock.** `POST /auth/master` resolves whose session to mint on
 * the server — `LAWHA_ADMIN_USERNAME` if that account exists and holds the
 * role, otherwise the oldest administrator — so what opens is a real account's
 * session, flagged `viaMaster`, announced on the panel behind this, and written
 * to the server log. Every administrative action stays attributable to a
 * person; what went away is having to know which person.
 *
 * `POST /auth/login` with `master: true` still exists and still takes a
 * username. That is the other job the credential has: signing in *as* somebody
 * to reproduce a problem on their account.
 */
export const LawhaAdminGate = () => {
  const navigate = useNavigate();
  const { user, viaMaster, masterAdmin, config, refresh, signOut } =
    useLawhaSession();
  const { editorTheme, setAppTheme } = useAppTheme();

  // Offered only where the server says there is one to use. A deployment
  // without `LAWHA_MASTER_PASSWORD` shows no control for a feature it does not
  // have, and `config` is null when the server could not be reached at all —
  // which resolves to the same conservative answer rather than to a segment
  // that cannot work.
  const hasMaster = config?.hasMasterPassword === true;

  const [credential, setCredential] = useState<Credential>("account");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const useMaster = hasMaster && credential === "master";

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      // Both paths go through the bare request and then re-read the session,
      // rather than through `useLawhaSession().signIn`. That helper adopts the
      // login response straight into the shared atom, which is a round trip
      // saved and, here, two wrong answers: `viaMaster` is a fact about the
      // *session* and is absent from either response, so a master sign-in
      // adopted that way would be bounced by the very guard it just satisfied;
      // and `adopt` carries the previous `viaMaster` forward, so an ordinary
      // sign-in performed from inside a master session would keep claiming to
      // be one. Reading the session back is the only thing that produces the
      // flag the guard reads, and it is paid for only on this screen.
      if (useMaster) {
        await signInWithMasterPassword(password);
      } else {
        // Bypassing `signIn` used to cost the escrow unlock it did on the way
        // past — the only moment the password was in hand — so an
        // administrator who signed in here and then opened their boards found
        // every one of them locked. Nothing is derived from a password any
        // more (ADR 0012), so this door is the same as every other one.
        await signInRequest(username, password);
      }
      const next = await refresh();

      setPassword("");
      setIsBusy(false);

      // If that got them in, the guard above has already replaced this screen
      // and none of this reaches a mounted component. If it did not, saying so
      // is the entire point: a successful sign-in that silently re-renders the
      // same form is the failure mode the old redirect had, one screen further
      // on.
      if (!canReachAdmin(next.user, next.viaMaster, next.masterAdmin)) {
        setError(
          `Signed in as ${
            next.user?.username ?? username
          }, but that account is not an administrator.`,
        );
      }
    } catch (caught) {
      // Echoed rather than reworded. The server distinguishes 429 from 401 for
      // a caller who asked for the master password by name, precisely so an
      // administrator locked out by somebody else's guessing does not read it
      // as "my master password stopped working" (invariant 24). Substituting
      // our own sentence here would throw that away.
      setError(
        caught instanceof LawhaApiError
          ? caught.message
          : "Could not sign in. Try again.",
      );
      setIsBusy(false);
    }
  };

  const onSignOut = async () => {
    try {
      await signOut();
    } catch {
      // Nothing useful to say. The session either went or it did not, and the
      // form above is still the way in either way.
    }
    setError(null);
    setPassword("");
  };

  return (
    <LawhaPageShell>
      {/*
        `lw-admin-gate` alongside `lw-auth-card`, so this card's spacing can
        differ from sign-in's without a rule that reaches both. It is the only
        auth card whose intro is a heading rather than a heading and a
        sentence.
      */}
      <form className="lw-auth-card lw-admin-gate" onSubmit={onSubmit}>
        <div className="lw-auth-card__header">
          <LawhaLogo />
          <div className="lw-auth-card__header-spacer" />
          <LawhaThemeToggle editorTheme={editorTheme} onChange={setAppTheme} />
        </div>

        {/*
          The heading carries the top on its own. The paragraph that used to
          sit here — "This page manages accounts. Sign in as an administrator
          to continue." — restated the heading and the form beneath it, which
          is filler wearing an explanation's clothes.

          `__intro` keeps its rhythm rather than collapsing to the bare `h1`,
          because the conditional lines below it (who you are signed in as, and
          whether a session is already open) are real information and still
          belong in this block.
        */}
        <div className="lw-auth-card__intro">
          <h1>Administration</h1>
          {user ? (
            <p className="lw-admin-gate__whoami">
              Signed in as <strong>{user.username}</strong>
              {viaMaster ? " with the master password" : ""}.
            </p>
          ) : null}
          {masterAdmin ? (
            <p className="lw-admin-gate__whoami">
              An administration session is already open.
            </p>
          ) : null}
        </div>

        {hasMaster ? (
          // A radiogroup, not a tablist: there are no panels to switch between,
          // only two labels for the one password field below. Arrow keys move
          // between radios for free; a tablist would owe the roving tabindex
          // and the panel wiring that go with it, for nothing.
          <div
            className="lw-admin-gate__segmented"
            role="radiogroup"
            aria-label="Which password"
          >
            {(
              [
                ["account", "Use an account"],
                ["master", "Master password"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={credential === value}
                className={`lw-admin-gate__segment${
                  credential === value ? " lw-admin-gate__segment--on" : ""
                }`}
                data-testid={`admin-gate-${value}`}
                onClick={() => {
                  setCredential(value);
                  // The two credentials are different secrets. Carrying one
                  // across would send an account password to the master check,
                  // where a failure spends the global master budget that ten
                  // attempts a quarter-hour has to cover for everyone.
                  setPassword("");
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="lw-auth-card__fields">
          {/*
            No username on the master segment, and the server is what makes
            that honest rather than a shortcut. `POST /auth/master` resolves
            the administrator to act as itself — `LAWHA_ADMIN_USERNAME` if that
            account exists and holds the role, otherwise the oldest
            administrator — so the session it mints still belongs to a named
            person, still carries `viaMaster`, and is still written to the log.

            The alternative was a session with no user behind it. That would
            have turned every line this panel writes — password resets, role
            grants, role revocations — from "root granted admin to yasmin" into
            something unattributable, permanently, with no way to tell two
            holders of the credential apart afterwards.
          */}
          {useMaster ? null : (
            <LawhaField
              label="Username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="yasmin"
              required
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
          <LawhaField
            label={useMaster ? "Master password" : "Password"}
            name="password"
            type="password"
            // `current-password` on both, deliberately: a manager offering the
            // account's saved password on the master segment is a nuisance,
            // and any other value here makes it offer nothing at all on the
            // segment where saving is genuinely useful.
            autoComplete="current-password"
            placeholder="••••••••"
            required
            // Focus follows the field that is actually there. Without this,
            // switching to the master segment leaves focus on a control that
            // has just been unmounted and the caret lands nowhere.
            autoFocus={useMaster}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error ? (
          <p className="lw-auth-card__error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="lw-btn lw-btn--primary lw-auth-card__submit"
          disabled={isBusy}
        >
          {isBusy ? "Signing in…" : "Continue"}
        </button>

        <div className="lw-auth-card__rule" />

        <div className="lw-auth-card__alt">
          {/*
            `/home`, not `/`. Both are the dashboard for a signed-in visitor,
            but `/` is `LandingRoute`, which decides between the dashboard and
            the sign-in screen from a session this component may be about to
            change. Naming the destination means "back" cannot land on a
            blank canvas because the atom had not caught up yet.
          */}
          <button
            type="button"
            className="lw-btn"
            onClick={() => navigate("/home")}
          >
            Back to boards
          </button>
          {user ? (
            <button type="button" className="lw-btn" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
        </div>

        {/*
          The card closes on the `__alt` row above. It used to end on a
          "locked out? ..." note, which was the only child of a span that
          existed to hold it — so the span goes with the string rather than
          being left as an empty element that still takes its margin.
        */}
      </form>
    </LawhaPageShell>
  );
};
