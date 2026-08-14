import { useState } from "react";

import { adminCreateUser } from "../auth/authApi";
import {
  LawhaPasswordField,
  isPasswordAcceptable,
} from "../pages/LawhaPasswordField";

import type { LawhaUser } from "../auth/authApi";

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Creating an account from the panel. See ADR 0015.
 *
 * The only way to onboard somebody on a server with open registration off,
 * which is the configuration a private deployment should be in. Without it the
 * operator's choice was to open registration to the whole LAN for the minute
 * it takes one person to sign up, and remember to close it again.
 *
 * Collapsed by default. It is the least-used control on the page and the list
 * above it is what people come here for; an always-open form would push the
 * accounts down the screen for the sake of something used once a month.
 */
export const LawhaAdminCreate = ({
  busy,
  onCreated,
  onError,
}: {
  busy: boolean;
  /** `password` is the generated one, or null when the operator set it. */
  onCreated: (user: LawhaUser, password: string | null) => void;
  onError: (message: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [working, setWorking] = useState(false);

  /**
   * An empty password field means "let the server generate one", which is the
   * common case — the point is a string to read down a phone. A partly typed
   * one is not the same thing, so it has to be acceptable and confirmed before
   * the button unlocks.
   */
  const wantsGenerated = password === "" && confirm === "";
  const canSubmit =
    username.trim().length > 0 &&
    (wantsGenerated ||
      (isPasswordAcceptable(password) && password === confirm));

  const reset = () => {
    setUsername("");
    setPassword("");
    setConfirm("");
    setIsAdmin(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || working || busy) {
      return;
    }
    setWorking(true);
    try {
      const result = await adminCreateUser(username.trim(), {
        ...(wantsGenerated ? {} : { password }),
        ...(isAdmin ? { isAdmin: true } : {}),
      });
      reset();
      setOpen(false);
      onCreated(result.user, result.password);
    } catch (caught) {
      onError(messageOf(caught, "Could not create that account."));
    } finally {
      setWorking(false);
    }
  };

  if (!open) {
    return (
      <div className="lw-actions lw-admin__create-trigger">
        <button
          type="button"
          className="lw-btn"
          onClick={() => setOpen(true)}
          disabled={busy}
        >
          Create an account
        </button>
      </div>
    );
  }

  return (
    <form className="lw-admin__create" onSubmit={submit}>
      <div className="lw-section">
        <span className="lw-section__title">Create an account</span>
        <span className="lw-section__caption">
          Leave the password blank and one will be generated for you to read
          out. They can change it once they are in.
        </span>
      </div>

      <label className="lw-field">
        <span className="lw-field__label">Username</span>
        <input
          className="lw-field__input"
          value={username}
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>

      {/*
        `optional`, and it is load-bearing rather than cosmetic: leaving this
        blank is what asks the server to generate a password, and the field's
        default `required` makes the browser refuse to fire the form's submit
        event at all — a button that looks live and does nothing.
      */}
      <LawhaPasswordField
        label="Password (optional)"
        name="adminCreatePassword"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        confirm
        optional
        confirmValue={confirm}
        onConfirmChange={setConfirm}
      />

      <label className="lw-check">
        <input
          type="checkbox"
          checked={isAdmin}
          onChange={(event) => setIsAdmin(event.target.checked)}
        />
        <span>Make them an administrator</span>
      </label>

      <div className="lw-actions">
        <button
          type="submit"
          className="lw-btn lw-btn--primary"
          disabled={!canSubmit || working || busy}
        >
          {working ? "Creating…" : "Create account"}
        </button>
        <button
          type="button"
          className="lw-btn"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
