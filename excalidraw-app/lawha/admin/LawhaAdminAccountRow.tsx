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
  | "role";

interface Confirmation {
  action: RowAction;
  /** Rendered inside the confirm strip. Names the account and the effect. */
  question: string;
  verb: string;
  danger: boolean;
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
    case "signOut":
      return {
        action,
        question: `Sign ${user.username} out of every device? Their password still works, so they can sign back in.`,
        verb: "Sign them out",
        danger: false,
      };
    // Enabling and role changes are reversible in one click and destroy
    // nothing, so a confirmation would be a speed bump rather than a guard —
    // and a product that asks about everything gets clicked through on the
    // one question that mattered.
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
  onAction: (action: RowAction, user: LawhaUser) => void;
}

export const LawhaAdminAccountRow = ({
  user,
  isYou,
  busy,
  isLastAdmin,
  onAction,
}: LawhaAdminAccountRowProps) => {
  const [confirming, setConfirming] = useState<Confirmation | null>(null);

  const disabled = user.disabledAt !== null;

  const run = (action: RowAction) => {
    const confirmation = confirmationFor(action, user);
    if (confirmation) {
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
      </div>

      {confirming ? (
        /*
         * `alertdialog`, inline, and it replaces the buttons rather than
         * sitting beside them — so the action being confirmed cannot be
         * clicked a second time while its own question is on screen.
         */
        <div className="lw-admin-row__confirm" role="alertdialog">
          <p className="lw-admin-row__confirm-text">{confirming.question}</p>
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
              disabled={busy}
              onClick={() => {
                const { action } = confirming;
                setConfirming(null);
                onAction(action, user);
              }}
            >
              {confirming.verb}
            </button>
          </div>
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
        </div>
      )}
    </li>
  );
};
