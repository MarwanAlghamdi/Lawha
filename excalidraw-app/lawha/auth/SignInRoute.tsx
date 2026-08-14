import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAppTheme } from "../../useHandleAppTheme";
import { LawhaLogo } from "../chrome/LawhaLogo";
import { LawhaThemeToggle } from "../chrome/LawhaThemeToggle";
import {
  LAWHA_CONTACT_CHANNEL,
  LAWHA_CONTACT_HANDLE,
  hasLawhaContact,
} from "../contact";
import { LawhaField } from "../pages/LawhaField";
import { LawhaPageShell } from "../pages/LawhaPageShell";

import { LawhaApiError } from "./authApi";
import { useLawhaSession } from "./useLawhaSession";

import "./LawhaAuth.scss";

interface LawhaSignInCardProps {
  /** Where to send the browser once a session exists. */
  redirectTo: string;
}

/**
 * The sign-in card.
 *
 * This used to be exported and rendered in a second place — `/admin`, whose
 * guard put it on screen verbatim so that a URL-guesser saw an ordinary sign-in
 * rather than a page confirming they had found the administration screen. That
 * was the reason `redirectTo` accepted `null`: signing in *at* `/admin` had to
 * leave the URL alone.
 *
 * `docs/adr/0009` gave that up. `/admin` now has `LawhaAdminGate`, which names
 * itself and offers the master password alongside an account, so this card has
 * one caller again and `redirectTo` is always a real destination. The null
 * branch went with it rather than staying behind as a path nothing takes.
 */
const LawhaSignInCard = ({ redirectTo }: LawhaSignInCardProps) => {
  const navigate = useNavigate();
  const { signIn, config } = useLawhaSession();
  const { editorTheme, setAppTheme } = useAppTheme();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      await signIn(username, password);
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      // The server deliberately does not say which half was wrong, and neither
      // do we — echoing its message keeps the two in step.
      setError(
        caught instanceof LawhaApiError
          ? caught.message
          : "Could not sign in. Try again.",
      );
      setIsBusy(false);
    }
  };

  return (
    <form className="lw-auth-card" onSubmit={onSubmit}>
      <div className="lw-auth-card__header">
        <LawhaLogo />
        <div className="lw-auth-card__header-spacer" />
        <LawhaThemeToggle editorTheme={editorTheme} onChange={setAppTheme} />
      </div>

      <div className="lw-auth-card__intro">
        <h1>Sign in</h1>
        {/*
          This used to read "Boards are end-to-end encrypted. Nothing leaves
          your control." Half of that was already false when ADR 0011 gave the
          server a key it could open, and all of it was false after ADR 0012
          removed the encryption outright — leaving the sign-in screen making a
          security promise the product had stopped keeping, to every person who
          ever signed in. The second sentence is still true and is the one that
          was doing the work: this is a server you run.
        */}
        <p>Your boards, on a server you run. Nothing leaves your control.</p>
      </div>

      <div className="lw-auth-card__fields">
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
        <LawhaField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {/*
          There used to be a "the password above is the master password"
          checkbox here, and it is gone. This screen is where people sign in to
          their own account, and the master password is not their credential —
          it belongs to whoever runs the server, and the only place it is any
          use is `/admin`, which now asks for it directly.

          Its removal is not a loss of function. `POST /auth/login` still
          accepts `master: true` and still needs a username beside it, which is
          the "sign in AS somebody to reproduce their problem" case; and
          `POST /auth/master` is the "every administrator is locked out" case.
          What went is one consequential credential being offered, permanently,
          to every person on the server who only ever wanted to type their own
          password.
        */}
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
        {isBusy ? "Signing in…" : "Sign in"}
      </button>

      <div className="lw-auth-card__rule" />

      <div className="lw-auth-card__alt">
        {config?.allowOpenRegistration === false ? (
          <span>
            New accounts are closed. Ask an administrator to create one for you.
          </span>
        ) : (
          <>
            <span>No account yet?</span>
            <button
              type="button"
              className="lw-btn"
              onClick={() => navigate("/signup")}
            >
              Create one
            </button>
          </>
        )}
      </div>

      {/*
        There is no password-reset link and there never will be — there is no
        email anywhere in Lawha (invariant 9), so the recovery path is a person.
        Naming that person is the whole point: "an administrator can set you a
        new one", which is what this said before, is true and useless, because
        the reader does not know who that is or how to reach them.

        The name comes from `lawha/contact.ts`, the same constants the dashboard
        footer reads, and not from a literal typed here. The dashboard note is
        only reachable once you are signed in, which is precisely the state
        somebody who has forgotten their password is not in — so this screen
        needs the same sentence, and two copies of a person's name is how one of
        them goes stale.

        Those constants ship EMPTY, so the second sentence is the one most
        deployments will show until somebody fills them in. It says the true
        thing rather than nothing: there is no email here, so a reset is a
        person handing over a link, and a reader who knows that much can at
        least go and find them. This screen is the one place the fallback
        genuinely costs something, which is the argument for setting them.
      */}
      <span className="lw-auth-card__note">
        {hasLawhaContact() ? (
          <>
            Forgot your password, or found a bug? Message{" "}
            <strong>{LAWHA_CONTACT_HANDLE}</strong> on {LAWHA_CONTACT_CHANNEL}.
          </>
        ) : (
          <>
            Forgot your password? Ask an administrator for a reset link — Lawha
            sends no email, so recovery is a person rather than an inbox.
          </>
        )}
      </span>
    </form>
  );
};

/** The whole sign-in screen: the card and the page chrome around it. */
const LawhaSignInScreen = ({ redirectTo }: LawhaSignInCardProps) => (
  <LawhaPageShell>
    <LawhaSignInCard redirectTo={redirectTo} />
  </LawhaPageShell>
);

/** `/signin`: the screen, returning you where you were going. */
export const SignInRoute = () => {
  const location = useLocation();
  const destination = (location.state as { from?: string } | null)?.from ?? "/";

  return <LawhaSignInScreen redirectTo={destination} />;
};
