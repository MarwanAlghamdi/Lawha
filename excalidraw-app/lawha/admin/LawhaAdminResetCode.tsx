import { useState } from "react";

import { LAWHA_CONTACT_CHANNEL } from "../contact";
import { ShareTargets } from "../share/ShareTargets";
import { buildShareTargets } from "../share/shareOrigins";

import type { ShareOrigins } from "../share/shareOrigins";

/**
 * A password reset code, shown once, with everything the administrator needs
 * in order to get it to the person it is for.
 *
 * Modelled on `LawhaAdminSecret`, which does the same job for a generated
 * password, and it holds the value the same way: component state and nothing
 * else — never storage, never a URL, never sent anywhere. The reasoning is
 * written out at `LawhaAdminAccounts.tsx` above the `secret` state and applies
 * here unchanged, with one thing on top of it. A generated password is a
 * *replacement* the person can be told at leisure; a reset code is a
 * **credential with an hour to live** that somebody may already be locked out
 * behind. Losing it is not an inconvenience, it is a colleague who cannot work
 * until another one is minted, and they have no way to ask for it except
 * finding an administrator again.
 *
 * That is why this panel does two things `LawhaAdminSecret` does not:
 *
 *   - it shows the whole **link**, not the code, because the code alone is not
 *     something a person can do anything with;
 *   - it **refuses to be dismissed silently** while the link has not been
 *     copied. Pressing Done without copying is the one mistake here that
 *     produces no error, no log line and no way back, so it gets a question.
 *     The second press goes through — this is a speed bump, not a lock.
 *
 * There is no email on this server (invariant 9) and nothing in the product
 * sends anything, so how the link travels is a fact the panel has to state
 * rather than a step it can take.
 */
export const LawhaAdminResetCode = ({
  who,
  code,
  expiresAt,
  locked,
  revokedSessions,
  origins,
  onDone,
}: {
  who: string;
  code: string;
  /** Epoch ms, from the server. Not recomputed here — see the note below. */
  expiresAt: number;
  /** Whether this mint also invalidated the password and ended the sessions. */
  locked: boolean;
  revokedSessions: number;
  /**
   * Every address this deployment answers to, from `useShareOrigins` two
   * components up.
   *
   * A prop rather than a hook call in here, mirroring `ShareCodes`: this
   * component is mounted by a credential arriving, and a fetch that started
   * then would let the row list grow under the hand of somebody already
   * copying. Fetched with the page, resolved by the time a code exists.
   */
  origins: ShareOrigins;
  onDone: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [askedToDiscard, setAskedToDiscard] = useState(false);

  /**
   * One row per route this deployment answers on, best first.
   *
   * This used to be `${window.location.origin}/reset/${code}` and nothing
   * else, on the reasoning that the address which worked for the administrator
   * is the one most likely to work for the person they are sending it to. That
   * reasoning is the bug `shareOrigins.ts` was written to delete, and it is
   * worse here than anywhere else it appeared: **whoever generated the link
   * decided the recipient's route**, and the recipient of this particular link
   * is by definition somebody who cannot sign in — so a LAN URL handed to
   * somebody off-network fails closed for them, and Lawha is not a channel
   * they can report that through.
   *
   * `buildShareTargets` reads no globals, which is the property that stops
   * this file re-deriving what it is fixing. Cheap and pure, so it runs on
   * every render rather than being memoised around a value that changes once.
   */
  const targets = buildShareTargets(origins, `/reset/${code}`);

  /**
   * The fallback, for a deployment that has published no origins at all —
   * which is the live shape of this one, and therefore not a degradation path
   * but the ordinary case. With nothing to choose between, the ambient origin
   * is the only honest guess available and the panel behaves exactly as it did
   * before any of this existed.
   */
  const link = `${window.location.origin}/reset/${code}`;

  /**
   * Absent entirely on a plain-http origin, which is what this deployment is
   * behind its gateway — browsers hand out `navigator.clipboard` only in a
   * secure context (ADR 0018). Checked up front rather than discovered on
   * click, so the button says what it can do instead of doing nothing.
   */
  const clipboardAvailable =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  /**
   * The server's own deadline, rendered rather than restated.
   *
   * "About an hour" is what the design says and what the person will remember,
   * but a clock time is what they can act on — and taking it from `expiresAt`
   * rather than from `Date.now() + 3600_000` means a server that ever changes
   * the lifetime changes this line too, instead of leaving the panel confidently
   * wrong.
   */
  const expiresAtLabel = new Date(expiresAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyFailed(false);
      // Copying is the thing the warning below was asking for, so it answers
      // the question rather than leaving it on screen next to a satisfied
      // condition.
      setAskedToDiscard(false);
    } catch {
      // Never silently. A refused clipboard used to present as a button that
      // visibly did nothing, which is the failure mode this codebase keeps
      // relearning. The link is on screen and selectable, so the recovery is
      // easy — it just has to be said.
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const done = () => {
    if (!copied && !askedToDiscard) {
      setAskedToDiscard(true);
      return;
    }
    onDone();
  };

  return (
    <div
      className="lw-admin__reset"
      role="status"
      data-testid="admin-reset-code"
    >
      <span className="lw-section__title">Give this link to {who}</span>

      {targets.length > 0 ? (
        /*
         * The trade, said rather than left silent.
         *
         * The `public` row hands a one-time password-reset credential to
         * somebody through a third party that terminates TLS — ngrok can read
         * this code in flight, and an hour is long enough to redeem it before
         * the person it was minted for does. That objection is real and it is
         * conceded here rather than argued away: the same concession is
         * already made one panel over, where ADR 0014's invite code is
         * likewise a credential and `ShareCodes` has offered it over the
         * tunnel since the sharing work landed, so refusing it here would be
         * an inconsistency rather than a policy.
         *
         * What decides it is that withholding the route is not neutral. The
         * alternative on offer was a LAN URL handed to somebody off-network,
         * which fails closed for the one person who cannot use Lawha to say
         * so. The mitigations available from here are the ones already built:
         * the public route is labelled, is never first, and carries the
         * liveness dot and the cost line beside it.
         */
        <ShareTargets
          targets={targets}
          subject="Reset link"
          // The code itself is 43 characters of base64url and is NOT on screen
          // anywhere on its own, so unlike the invite panel there is nothing
          // here to read out — the selectable field is the whole of the
          // recovery, which is what this sentence has to point at.
          onCopyError={() => setCopyFailed(true)}
        />
      ) : (
        <input
          className="lw-admin__reset-link"
          type="text"
          readOnly
          aria-label={`Password reset link for ${who}`}
          value={link}
          // Selects the whole thing, so the manual path on a browser with no
          // clipboard is one click and Ctrl+C.
          onFocus={(event) => event.target.select()}
        />
      )}

      <div className="lw-actions">
        {targets.length > 0 ? null : clipboardAvailable ? (
          <button type="button" className="lw-btn" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        ) : (
          // No button at all rather than one that cannot work.
          <span className="lw-field__hint">
            Click the box above, then Ctrl+C — this browser has no clipboard
            access over plain http.
          </span>
        )}
        <button type="button" className="lw-btn lw-btn--primary" onClick={done}>
          {askedToDiscard ? "Discard it anyway" : "Done"}
        </button>
      </div>

      {copyFailed ? (
        <p className="lw-inline-error" role="alert">
          The browser refused the clipboard. Click the link above and press
          Ctrl+C.
        </p>
      ) : null}

      {askedToDiscard ? (
        <p className="lw-inline-error" role="alert">
          {/*
            A question when there are several routes, a statement when there is
            one, and the difference is not phrasing — it is what this component
            can honestly claim to know. `ShareTargets` owns its own copy
            buttons and reports a failure but never a success, so with rows on
            screen `copied` stays false however many times the administrator
            copied. Keeping the old sentence would state, as a fact, that
            somebody had not done the thing they had just done — about the one
            string on this page that cannot be shown a second time. The speed
            bump itself survives either way: one press asks, the next goes
            through.
          */}
          {targets.length > 0
            ? "Have you copied one of the links? It is stored hashed and cannot be shown again — press Discard it anyway if you have it, or copy it first."
            : "You have not copied this yet. It is stored hashed and cannot be shown again — press Discard it anyway if you have it written down, or copy it first."}
        </p>
      ) : null}

      {/*
        What the administrator has just done to somebody, in the panel that did
        it. A lock ends a live session, and the person it happened to finds out
        by being thrown out of a board mid-sentence.
      */}
      <p
        className={`lw-admin__reset-fact${
          locked ? " lw-admin__reset-fact--locked" : ""
        }`}
      >
        {locked ? (
          <>
            <strong>{who}</strong> is locked out now — their password no longer
            works
            {revokedSessions > 0
              ? `, and they were signed out of ${revokedSessions} device${
                  revokedSessions === 1 ? "" : "s"
                }`
              : ", and they had no session open"}
            . They cannot sign in at all until they use this link.
          </>
        ) : (
          <>
            Nothing has happened to <strong>{who}</strong> yet — their password
            still works and they are still signed in wherever they were. That
            changes when they use this link.
          </>
        )}
      </p>

      {/*
        "or on <channel>" only when a channel is configured. Unconfigured it
        reads "hand the link over in person", which is the stricter instruction
        and a fine thing to be left with — unlike the sentence with the hole in
        it that naming an empty constant would produce.
      */}
      <span className="lw-field__hint">
        Works once, and stops working at {expiresAtLabel} — about an hour from
        now. Nothing is sent from here: hand the link over in person
        {LAWHA_CONTACT_CHANNEL.trim().length > 0
          ? ` or on ${LAWHA_CONTACT_CHANNEL}`
          : ""}
        . It is shown once and cannot be shown again, so if you lose it you will
        have to make another.
      </span>
    </div>
  );
};
