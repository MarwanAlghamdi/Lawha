import { useState } from "react";

import type { LawhaUser } from "../auth/authApi";

/**
 * One account, and everything an administrator can do to it. See ADR 0015.
 *
 * The row is the page. The old panel put a list at the top and a form
 * underneath it, so acting on somebody meant selecting them, scrolling to a
 * form, and trusting that the form was still about the person you picked —
 * with the account's name appearing in two places that could disagree. Here
 * every action names its target because the target is the thing it is inside.
 *
 * **Every destructive action confirms in place**, and never with a native
 * dialog (invariant 19). The row stays visible above the question, so the name
 * being confirmed is the name on screen: a generic "are you sure" gets clicked
 * through, one that states the account and the consequence does not.
 */

export type RowAction =
  | "resetCode"
  | "lockAndReset"
  | "disable"
  | "enable"
  | "signOut"
  | "role"
  | "delete"
  | "restore";

interface Confirmation {
  action: RowAction;
  /** Rendered inside the confirm strip. Names the account and the effect. */
  question: string;
  verb: string;
  danger: boolean;
  /**
   * A word the administrator must type before the button unlocks.
   *
   * Only Delete uses it, and only Delete should. Every other action on this
   * row is undone by pressing the other button beside it; this one starts a
   * thirty-day clock and then takes an account and its boards for good. A
   * confirm strip is read after the decision — typing the name is the one
   * thing on this panel that cannot be done without looking at *which* row
   * you are on, which is the mistake that actually happens.
   *
   * The server checks it too, and the server's check is the one that counts
   * (invariant 21). This is a speed bump on the way to a guarantee, not the
   * guarantee.
   */
  challenge?: string;
}

const confirmationFor = (
  action: RowAction,
  user: LawhaUser,
): Confirmation | null => {
  switch (action) {
    /*
     * The two halves of "Reset password", and the reason both of them ask.
     *
     * They mint the same kind of code and differ by one flag, so the entire
     * consequence of pressing the wrong one is invisible in the request and
     * obvious to the colleague on the other end. Each question therefore states
     * its OWN effect rather than a shared "are you sure": the harmless one
     * promises that nothing changes, the destructive one says what stops
     * working and when.
     */
    case "resetCode":
      return {
        action,
        question: `Make a reset code for ${user.username}? Nothing changes until they use it — their password and their sessions keep working. You get a link to hand over, and it is shown once.`,
        verb: "Make the code",
        // Not `danger`, because it does nothing to the account. It still asks:
        // a reset code is a live credential, and minting one by mis-click is
        // worth a question even when the account is untouched.
        danger: false,
      };
    case "lockAndReset":
      return {
        action,
        question: `Lock ${user.username} out and make a reset code? Their password stops working now and every device is signed out. They cannot sign in until they use the code — which is shown once, so be ready to hand it over.`,
        verb: "Lock and reset",
        danger: true,
      };
    case "disable":
      return {
        action,
        question: `Turn off ${user.username}? They cannot sign in and any session they have ends now. Nothing is deleted — you can turn them back on.`,
        verb: "Turn off",
        danger: true,
      };
    case "delete":
      return {
        action,
        question: `Delete ${user.username}? Every board they own goes with them — including boards they shared with other people, which disappear from those dashboards immediately. It can be undone from here for 30 days, and then it cannot be undone at all. Type ${user.username} to confirm.`,
        verb: "Delete account",
        danger: true,
        challenge: user.username,
      };
    case "signOut":
      return {
        action,
        question: `Sign ${user.username} out of every device? Their password still works, so they can sign back in.`,
        verb: "Sign them out",
        danger: false,
      };
    // Enabling, restoring and role changes are reversible in one click and
    // destroy nothing, so a confirmation would be a speed bump rather than a
    // guard — and a product that asks about everything gets clicked through on
    // the one question that mattered.
    default:
      return null;
  }
};

interface LawhaAdminAccountRowProps {
  user: LawhaUser;
  isYou: boolean;
  busy: boolean;
  /** True when this is the last administrator who could still sign in. */
  isLastAdmin: boolean;
  /**
   * Every action this row offers, and there is no second callback beside it.
   *
   * There used to be an `onSetPassword` carrying a typed value, for a control
   * that set the account's password outright. It went with `POST
   * /admin/users/:id/password` (design spec §2): an administrator who sets a
   * password knows it, so nothing that account does afterwards can be
   * attributed to its owner. Every action a row can now take is a `RowAction`
   * and carries nothing but which one.
   */
  onAction: (
    action: RowAction,
    user: LawhaUser,
    /**
     * What the administrator typed into the confirm strip, when the action
     * asked for something.
     *
     * Threaded through rather than left here, because the server compares it
     * with the account named in the path — and a container that supplied
     * `user.username` from the same object it read `user.id` from would make
     * the two incapable of disagreeing, which is the one thing the check
     * exists to detect. The value that travels has to be the value a human
     * typed.
     */
    confirmed?: string,
    /**
     * Returns `void | Promise<void>` so the container can pass its own async
     * handler **directly**, with no adapter in the JSX.
     *
     * There was one, and it read `(action, target) => void onAction(action,
     * target)`. A two-parameter function is assignable to a three-parameter
     * type, so it type-checked perfectly and threw the typed username away on
     * every delete — the server then received `{"username":""}` and refused
     * with a raw schema error. Nothing but driving the real panel found it.
     * Removing the adapter removes the whole class.
     */
  ) => void | Promise<void>;
}

export const LawhaAdminAccountRow = ({
  user,
  isYou,
  busy,
  isLastAdmin,
  onAction,
}: LawhaAdminAccountRowProps) => {
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [typed, setTyped] = useState("");

  const disabled = user.disabledAt !== null;
  const deleted = user.deletedAt !== null;

  // Case-insensitive, matching the server, which compares normalised
  // usernames. Requiring the exact display casing would reject a correct
  // confirmation, and a box that rejects the right answer teaches people to
  // stop reading it.
  const challengeMet =
    !confirming?.challenge ||
    typed.trim().toLowerCase() === confirming.challenge.toLowerCase();

  const run = (action: RowAction) => {
    const confirmation = confirmationFor(action, user);
    if (confirmation) {
      setTyped("");
      setConfirming(confirmation);
      return;
    }
    onAction(action, user);
  };

  return (
    <li
      className={`lw-admin-row${disabled ? " lw-admin-row--off" : ""}`}
      data-testid={`admin-row-${user.username}`}
    >
      <div className="lw-admin-row__head">
        <span className="lw-admin-row__name">
          {user.username}
          {isYou ? <span className="lw-admin-row__self"> (you)</span> : null}
        </span>
        {user.isAdmin ? (
          <span className="lw-chip lw-chip--orange">admin</span>
        ) : null}
        {disabled ? <span className="lw-chip">turned off</span> : null}
        {deleted ? (
          <span className="lw-chip lw-chip--danger">deleted</span>
        ) : null}
      </div>

      {confirming ? (
        /*
         * `alertdialog`, inline, and it replaces the buttons rather than
         * sitting beside them — so the action being confirmed cannot be
         * clicked a second time while its own question is on screen.
         */
        <div className="lw-admin-row__confirm" role="alertdialog">
          <p className="lw-admin-row__confirm-text">{confirming.question}</p>
          {confirming.challenge ? (
            <input
              type="text"
              className="lw-admin-row__challenge"
              // Named for what it is rather than labelled "confirm": a screen
              // reader user gets the same instruction the sighted one reads in
              // the question above.
              aria-label={`Type ${confirming.challenge} to confirm`}
              placeholder={confirming.challenge}
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          ) : null}
          <div className="lw-actions">
            <button
              type="button"
              className="lw-btn"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`lw-btn${confirming.danger ? " lw-btn--danger" : ""}`}
              disabled={busy || !challengeMet}
              onClick={() => {
                const { action } = confirming;
                const confirmed = typed.trim();
                setConfirming(null);
                onAction(action, user, confirmed || undefined);
              }}
            >
              {confirming.verb}
            </button>
          </div>
        </div>
      ) : deleted ? (
        /*
         * A deleted account offers Restore and nothing else.
         *
         * Not the usual bar with everything greyed out. Reset, lock-and-reset,
         * sign-out, turn-off and the role toggle are all refused by
         * `assertNotDeleted` in `admin.ts` for an account in the trash, so
         * rendering them disabled would say "these are things you could do
         * here" about five things you cannot (invariant 24). One row, one
         * remaining decision.
         */
        <div className="lw-admin-row__actions">
          <span className="lw-admin-row__note">
            Deleted. Their boards are gone from everyone&apos;s dashboard, and
            all of it is destroyed for good when the window closes.
          </span>
          <button
            type="button"
            className="lw-btn"
            disabled={busy}
            onClick={() => run("restore")}
          >
            Restore
          </button>
        </div>
      ) : (
        <div className="lw-admin-row__actions">
          {/*
            The two reset actions, side by side, and the whole design problem
            of this row: they are one word apart and only one of them signs a
            colleague out of a live session. The confirmation states the
            difference, but a confirmation is read after the decision — so the
            difference is also carried here, where the pointer is: the
            destructive one is coloured as destructive, and both say what they
            do on hover and to a screen reader.

            Both are refused for a turned-off account, because the redemption
            route refuses one: `passwordReset.ts` answers ACCOUNT_DISABLED for
            a code whose user is not active. Minting one anyway would hand the
            administrator a link to pass on that is already dead, and they
            would find out from the person who tried it (invariant 24).

            **"Make", not "Send".** The design spec called this one "Send a
            reset code" and that word was wrong for what the product does:
            nothing is sent. There is no email anywhere in Lawha (invariant 9)
            and this button posts to one route that answers with a string —
            the administrator then has to hand it over themselves, in person
            or on whatever `lawha/contact.ts` names, which is what the panel
            says once the code exists. A
            label promising delivery is a label somebody trusts: they press it,
            read "reset code sent", and wait for a colleague to get an email
            that no part of this system can produce. The verb has to match the
            mechanism, so it names the only thing the click actually does.
          */}
          <button
            type="button"
            className="lw-btn"
            disabled={busy || disabled}
            title={
              disabled
                ? "Turn the account back on first — a reset code is refused while it is off."
                : "Nothing changes until they use it — their password and their sessions keep working."
            }
            onClick={() => run("resetCode")}
          >
            Make a reset code
          </button>

          <button
            type="button"
            className="lw-btn lw-btn--danger"
            disabled={busy || disabled}
            title={
              disabled
                ? "Turn the account back on first — a reset code is refused while it is off."
                : "Their password stops working now and every device is signed out."
            }
            onClick={() => run("lockAndReset")}
          >
            Lock and reset
          </button>

          {/*
            There is no third reset control here, and its absence is the point
            of the whole feature. `Set password…` used to sit between these
            two and the one below, opening a form that posted a password the
            administrator had typed. It is gone with `POST
            /admin/users/:id/password` — the route answers 404 now, so nothing
            is preserved behind a removed button. Read design spec §1 before
            adding anything back: the reason is not that the control was
            dangerous, it is that an administrator who knows an account's
            password makes everything that account does afterwards
            unattributable to the person who owns it.

            The master password and `lawha-server`'s `reset-password` CLI
            survive, both deliberately: one exists for every administrator
            being locked out and announces itself on the session it creates,
            the other needs shell access to the host.
          */}
          <button
            type="button"
            className="lw-btn"
            disabled={busy || disabled}
            onClick={() => run("signOut")}
          >
            Sign out everywhere
          </button>

          <button
            type="button"
            className="lw-btn"
            // The server refuses demoting the last administrator who can
            // still sign in, and invariant 24 says the client must know what
            // the server will refuse — offering a control that always fails is
            // worse than not offering it.
            disabled={busy || (user.isAdmin && isLastAdmin)}
            title={
              user.isAdmin && isLastAdmin
                ? "This is the only administrator who can sign in. Promote someone else first."
                : undefined
            }
            onClick={() => run("role")}
          >
            {user.isAdmin ? "Revoke admin" : "Make admin"}
          </button>

          <button
            type="button"
            className={`lw-btn${disabled ? "" : " lw-btn--danger"}`}
            // Turning yourself off is refused by the server too, and for the
            // same reason: nothing recovers from it through this page.
            disabled={
              busy || isYou || (!disabled && user.isAdmin && isLastAdmin)
            }
            title={isYou ? "You cannot turn off your own account." : undefined}
            onClick={() => run(disabled ? "enable" : "disable")}
          >
            {disabled ? "Turn back on" : "Turn off"}
          </button>

          {/*
            Last in the bar, and the only control here that ends anything.
            Refused by the server for your own account and for an
            administrator, so both are refused here too rather than offered and
            then rejected (invariant 24) — and the reason is in the tooltip,
            because a disabled button with no explanation reads as a bug.

            "Turn off" sits immediately before it and is the answer most of the
            time: it stops the account dead, keeps every board, and is undone
            by pressing it again. This one takes the boards too.
          */}
          <button
            type="button"
            className="lw-btn lw-btn--danger"
            disabled={busy || isYou || user.isAdmin}
            title={
              isYou
                ? "Delete your own account from your account page."
                : user.isAdmin
                ? "This account is an administrator. Revoke that first."
                : undefined
            }
            onClick={() => run("delete")}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
};
