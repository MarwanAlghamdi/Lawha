import { useState } from "react";

interface LawhaAdminBackupPromptProps {
  /** What is about to be handed over, named. */
  what: string;
  /** True for a master-password session, which has no account password to ask for. */
  masterOnly: boolean;
  /**
   * True when the file about to download is `age` ciphertext — a scheduled
   * backup taken while `LAWHA_BACKUP_RECIPIENT` was configured. A file
   * someone cannot open, with no explanation, is worse than the finding
   * this closes, so the requirement is said here, at the point of download,
   * not discovered later by a double-click that does nothing.
   */
  encrypted: boolean;
  /**
   * True when the DATABASE inside the download is SQLCipher — the server was
   * started with `LAWHA_DB_KEY` set, or this archive entry was taken while it
   * was. Separate from `encrypted` above because the two are different keys
   * protecting different things, and a download can need either, both or
   * neither: `age` wraps the artefact, `LAWHA_DB_KEY` is inside it.
   *
   * The on-demand snapshot is exactly why this exists. It never routes through
   * `age`, so `encrypted` is correctly false for it — and the page said so, in
   * a sentence that promised the download was "in plain form". On a keyed
   * deployment that was not incomplete, it was WRONG, and it is the same
   * failure this prompt already exists to prevent, aimed the other way.
   */
  databaseKeyed: boolean;
  busy: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Type your password again before the database leaves the building.
 *
 * Being signed in as an administrator is already enough to reset anyone's
 * password from the row above this one, so asking again here is not about
 * authorization — the server has already decided that. It is about the gap
 * between an admin session existing and an admin being *present*: this one
 * button hands over every board, every password hash and every live session in
 * a single file, and it is the only control on the page where a walked-away
 * laptop and a misclick have the same consequence as a stolen cookie.
 *
 * Inline and `role="alertdialog"`, never `window.confirm` (invariant 19) and
 * never a floating modal — the admin page is not the dashboard, and a native
 * dialog blocks the renderer until it is dismissed.
 *
 * The warning text is deliberately specific about what is inside the file.
 * "Are you sure?" tells an operator nothing they can weigh; "every board,
 * password hash and active session" tells them exactly what they are about to
 * be responsible for keeping safe.
 */
export const LawhaAdminBackupPrompt = ({
  what,
  masterOnly,
  encrypted,
  databaseKeyed,
  busy,
  onSubmit,
  onCancel,
}: LawhaAdminBackupPromptProps) => {
  const [password, setPassword] = useState("");

  return (
    <form
      className="lw-backup__prompt"
      role="alertdialog"
      aria-label={`Confirm before downloading ${what}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (password) {
          onSubmit(password);
        }
      }}
    >
      <p className="lw-backup__prompt-text">
        <strong>{what}</strong> contains every board, every password hash and
        every active session on this server. Anyone who gets the file gets all
        of it. Keep it somewhere you would keep the server itself.
      </p>

      {encrypted ? (
        <p className="lw-backup__prompt-text">
          This copy is encrypted to this server's configured backup key. The
          download will be unreadable without the matching{" "}
          <strong>private</strong> key (<code>age -d -i &lt;identity&gt;</code>)
          — without it, this file is not a substitute for a working restore.
        </p>
      ) : null}

      {databaseKeyed ? (
        <p className="lw-backup__prompt-text">
          The database inside this download is encrypted with{" "}
          <code>LAWHA_DB_KEY</code>, and opening it needs that exact value from{" "}
          <code>lawha.env</code> — this server's own key, not the{" "}
          <strong>age</strong> one above. Without it the file is bytes, not a
          backup.
        </p>
      ) : null}

      <label className="lw-field">
        <span className="lw-field__label">
          {masterOnly ? "Master password" : "Your password"}
        </span>
        <input
          className="lw-input"
          type="password"
          autoComplete="current-password"
          value={password}
          // Autofocus is right here and wrong in most places: this form only
          // exists because somebody just clicked the button that opens it, so
          // the caret is where they are already looking.
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <div className="lw-actions">
        <button
          type="button"
          className="lw-btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="lw-btn lw-btn--danger"
          disabled={busy || password.length === 0}
        >
          {busy ? "Preparing…" : "Download"}
        </button>
      </div>
    </form>
  );
};
