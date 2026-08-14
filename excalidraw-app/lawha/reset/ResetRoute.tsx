import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  RESET_UNREACHABLE,
  previewReset,
  redeemReset,
} from "../../data/passwordReset";
import { useLawhaSession } from "../auth/useLawhaSession";
import {
  LAWHA_CONTACT_CHANNEL,
  LAWHA_CONTACT_HANDLE,
  hasLawhaContact,
} from "../contact";
import {
  LawhaPasswordField,
  isPasswordAcceptable,
} from "../pages/LawhaPasswordField";

import "./ResetRoute.scss";

import type { ResetPreview } from "../../data/passwordReset";
import type { ReactNode } from "react";

/**
 * Spending a password reset code. See
 * docs/adr/0021-admin-password-reset-codes.md.
 *
 * This is the page the whole feature exists for. An administrator who sets a
 * password *knows* it, so nothing that account does afterwards can be
 * attributed to the person who owns it; here the owner chooses a password
 * nobody else ever sees, and the audit row the server writes names **them**.
 *
 * **No session gate, and that is the requirement rather than an omission.**
 * `/join/:code` sits behind `RequireSession` because a code grants membership
 * and membership needs an account to belong to. A reset code is redeemed by
 * somebody who *cannot* authenticate — that is the premise — so there is no
 * `RequireSession` here. There is no `RedirectIfSignedIn` either: an unlocked
 * "I forgot it" reset leaves the person signed in, and somebody already signed
 * in may still be redeeming a code for themselves, so bouncing them to `/`
 * would make the code they were just handed unusable.
 *
 * **One route, not two.** `/join` has a typed-code variant because three words
 * are something a person can be told and type. A reset code is 43 base64url
 * characters read off a screen; there is no `/reset` without a code, because
 * nobody is going to type one.
 *
 * **It previews before it redeems**, like `/join`. The GET is idempotent and
 * the POST is the deliberate act, which is what makes the page refreshable —
 * and what lets it name the account before a password is set on it.
 */

/**
 * The handle to ask, in one place, so it cannot go stale in seven.
 *
 * A NOUN PHRASE in both branches, because every one of the sentences below
 * drops it mid-clause — "tell …", "ask … for another", "ask … what happened".
 * The unconfigured fallback therefore has to read as a person too. "an
 * administrator" is weaker than a name and it is the honest weaker thing; the
 * alternative, dropping the clause when nobody is named, leaves "Try again in a
 * moment, and tell ." on the screen of somebody already locked out.
 */
const Contact = () =>
  hasLawhaContact() ? (
    <>
      <strong>{LAWHA_CONTACT_HANDLE}</strong> on {LAWHA_CONTACT_CHANNEL}
    </>
  ) : (
    <>an administrator</>
  );

/**
 * What to do about a code that will not work, keyed on the server's `code`
 * rather than on its sentence.
 *
 * The sentence itself is echoed straight from the server (see `refusal.message`
 * below) so the two cannot drift; this is the half the server has no business
 * writing, because it is about the person's next move rather than about the
 * row in the table. The five branches are the five `routes/passwordReset.ts`
 * distinguishes, and each of them changes what a person should actually do:
 * a late code wants another one, a revoked code wants a conversation first,
 * and a spent code they did not spend is somebody else holding it.
 *
 * No email, no inbox, no "we sent you a link" (invariant 9). The code was
 * handed over in person or by chat, and so is its replacement.
 *
 * **Three of these branches are not about the code at all**, and separating
 * them out is a defect fixed rather than a nicety. Every transport failure used
 * to arrive here as `null` and get the truncated-link advice — for a code that
 * was 43 characters, whole, and perfectly valid. A stopped `lawha-server`
 * produces exactly that on this stack: `docker/nginx.conf` serves the SPA
 * statically and proxies only `/api/`, so the page renders fine over an `/api`
 * answering nginx's HTML 502. `RATE_LIMITED` was the sharpest of them, because
 * the advice it gave — ask for another code — cannot work: the bucket is keyed
 * on the address, not on the code, so a replacement is refused just as hard.
 */
const nextStep = (code: string | null): ReactNode => {
  switch (code) {
    case RESET_UNREACHABLE:
      return (
        <>
          This is not about your code — nothing has been checked yet, and it is
          untouched. Wait a moment and try again. If it keeps happening, Lawha
          itself is probably not running; tell <Contact />.
        </>
      );
    case "RATE_LIMITED":
      return (
        <>
          Too many attempts from this address in the last quarter of an hour, so
          the code has not been looked at. Wait about fifteen minutes and try
          again — asking for a new code will not help, because the limit counts
          the address rather than the code.
        </>
      );
    case "INTERNAL":
      return (
        <>
          Something went wrong at the server's end rather than with your code.
          Try again in a moment, and tell <Contact /> if it keeps happening.
        </>
      );
    case "EXPIRED":
      return (
        <>
          A reset code lasts about an hour, which is short on purpose — an
          intercepted one is usually already dead. Ask <Contact /> for another.
        </>
      );
    case "REVOKED":
      return (
        <>
          This one was turned off on purpose, so ask <Contact /> what happened
          before asking for another.
        </>
      );
    case "REDEEMED":
      return (
        <>
          If that was you, sign in with the password you chose. If it was not,
          then somebody else used it — tell <Contact /> now, and they can lock
          the account while you sort it out.
        </>
      );
    case "ACCOUNT_DISABLED":
      return (
        <>
          A new code will not help until the account is turned back on. Ask{" "}
          <Contact />.
        </>
      );
    default:
      // NO_SUCH_CODE, and anything the server grows later. A code is long and
      // arrives in a link, so the overwhelmingly likely cause is a link that
      // was cut short by whatever it travelled through.
      return (
        <>
          Check you copied the whole link — a code is 43 characters and chat
          apps cut them short. If it was whole, ask <Contact /> for a new one.
        </>
      );
  }
};

/**
 * Whether asking the same question again could produce a different answer.
 *
 * The three that can are the three that were never statements about the code:
 * nothing answered, the address is out of attempts, the server broke. Every
 * other refusal is durable — an expired code is expired for ever — and a "Try
 * again" beside one of those would be a worse dead end than none, because it
 * spends an attempt to be told the same thing.
 *
 * Kept as a list rather than as `!== "NO_SUCH_CODE"` and friends, so a refusal
 * the server grows later defaults to *not* retryable. Offering a retry for
 * something unknown is the failure mode with a cost; withholding one is not.
 */
const canRetry = (code: string | null): boolean =>
  code === RESET_UNREACHABLE || code === "RATE_LIMITED" || code === "INTERNAL";

export const ResetRoute = () => {
  const params = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const { setUser } = useLawhaSession();

  const code = params.code ?? "";

  const [preview, setPreview] = useState<ResetPreview | null>(null);
  /**
   * Why there is nothing to set a password on. Separate from `failure` below,
   * because they are different situations with different pages: a dead code
   * means no form at all, and a refused password means the same form again.
   */
  const [refusal, setRefusal] = useState<{
    message: string;
    code: string | null;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Bumped by "Try again", and in the effect's dependencies so that asking
   * again is a state change rather than a reload.
   *
   * A reload is what somebody does when a page looks broken, and it is the
   * worst available move here: it spends another of the ten attempts a quarter
   * hour allows, which is precisely what the rate-limited case cannot afford.
   */
  const [attempt, setAttempt] = useState(0);

  /**
   * The code this mount has already asked about.
   *
   * **Once per mount, not once per render.** `GET` and `POST
   * /api/auth/reset/:code` share one budget — 10 per quarter hour keyed on the
   * client address — so every extra preview is one fewer attempt for a person
   * who is locked out, and a page that previewed on each render would empty
   * the budget while they typed a password into it.
   *
   * A ref rather than a dependency array alone, because `index.tsx` wraps the
   * app in `<StrictMode>` and React 19 runs mount, cleanup, mount again in
   * development: a plain effect fires twice and spends two of the ten.
   *
   * Keyed on the code rather than a bare boolean so that navigating from one
   * reset link to another within the same mount would still ask. Nothing in
   * the app links here, so that is a backstop rather than a path.
   */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (!code || asked.current === code) {
      return;
    }
    asked.current = code;

    void (async () => {
      try {
        setPreview(await previewReset(code));
      } catch (caught: any) {
        setRefusal({
          message: caught?.message ?? "That code did not work.",
          code: caught?.code ?? null,
        });
      }
    })();

    // Deliberately no "ignore the answer if this effect was torn down" flag.
    // Combined with the ref above it is a hang rather than a safeguard: under
    // StrictMode the first invocation's answer would be discarded as stale and
    // the second would be skipped as already-asked, leaving the page on
    // "Checking…" for ever with nothing in any log. The effect never re-runs
    // for the same code, so there are never two answers to race, and a
    // setState after unmount is a no-op in React 19.
    //
    // `attempt` is in the dependencies and NOT in the ref's key. `retry` below
    // clears the ref before bumping it, so the guard still collapses
    // StrictMode's mount/cleanup/mount into one request — the budget is spent
    // once per deliberate press, never once per remount.
  }, [code, attempt]);

  /**
   * Ask again, for the refusals that were never about the code.
   *
   * Clearing `asked` is what makes the effect ask rather than return, and
   * clearing `refusal` is what puts "Checking that code…" back on screen — a
   * dead sentence left sitting beside a live button says the press did
   * nothing, which is the same silence this page exists to break.
   */
  const retry = () => {
    asked.current = null;
    setRefusal(null);
    setAttempt((previous) => previous + 1);
  };

  const ready = isPasswordAcceptable(password) && confirm === password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!preview || !ready || saving) {
      return;
    }

    setSaving(true);
    setFailure(null);
    try {
      const { user } = await redeemReset(preview.code, password);
      // The server has already replaced this browser's session cookie, but the
      // app's cached session is an atom the cookie cannot reach. Without this,
      // `/` reads the stale copy: somebody who was locked out is bounced
      // straight back to `/signin` a beat after being signed in, and somebody
      // who was signed in as another account keeps seeing that account's name.
      // Same call `signIn` makes, for the same reason.
      setUser(user);
      navigate("/", { replace: true });
    } catch (caught: any) {
      setFailure(caught?.message ?? "Could not set that password.");
      setSaving(false);
    }
  };

  return (
    <main className="lw-reset">
      <div className="lw-reset__card">
        <h1 className="lw-reset__title">Set a new password</h1>

        {refusal ? (
          <>
            <p className="lw-reset__error" role="alert">
              {refusal.message}
            </p>
            <p className="lw-reset__blurb">{nextStep(refusal.code)}</p>
            <div className="lw-reset__actions">
              {canRetry(refusal.code) ? (
                // First, and primary, because it is the move that can actually
                // work. "Sign in" stays beside it rather than being replaced:
                // somebody who reached a reset link by accident still wants the
                // other door, and a page with one button that might not help is
                // how the original defect felt from the inside.
                <button
                  type="button"
                  className="lw-btn lw-btn--primary"
                  onClick={retry}
                >
                  Try again
                </button>
              ) : null}
              <button
                type="button"
                className="lw-btn"
                onClick={() => navigate("/signin")}
              >
                Sign in
              </button>
            </div>
          </>
        ) : preview ? (
          <form className="lw-reset__form" onSubmit={submit}>
            <p className="lw-reset__blurb">
              You are setting the password for{" "}
              <strong>{preview.username}</strong>. Nobody else sees what you
              choose — not even whoever gave you this link.
            </p>

            <LawhaPasswordField
              label="New password"
              name="newPassword"
              autoComplete="new-password"
              autoFocus
              // `confirm` turns on both the second field and the rule
              // checklist, which is what states the length rule from the first
              // keystroke rather than letting a 400 announce it (invariant 24).
              confirm
              value={password}
              onChange={setPassword}
              confirmValue={confirm}
              onConfirmChange={setConfirm}
            />

            <p className="lw-mono lw-reset__note">
              this signs out every other device, including the one you left
              signed in
            </p>

            {failure ? (
              <p className="lw-reset__error" role="alert">
                {failure}
              </p>
            ) : null}

            <button
              type="submit"
              className="lw-btn lw-btn--primary"
              // Gated on the same rule the server applies, from the same
              // module, so the button cannot be live for a password that
              // `passwordSchema` would refuse.
              disabled={!ready || saving}
            >
              {saving ? "Setting…" : "Set my password"}
            </button>
          </form>
        ) : (
          // Neither answer yet. A sentence rather than a spinner, because the
          // one thing worth saying here is that nothing has happened to the
          // account.
          <p className="lw-reset__blurb">Checking that code…</p>
        )}
      </div>
    </main>
  );
};
