import { useState } from "react";

/**
 * A freshly minted password, shown once.
 *
 * The copy says "shown once" because it is literally true: the server stores
 * an argon2 hash and nothing else, so there is no second showing to fall back
 * on. Read-only input rather than plain text so the whole thing can be
 * selected and double-clicked as one token — an administrator dictating this
 * down a phone will lose their place otherwise, which is also why the
 * generator's alphabet has no `l`, `1`, `I`, `0` or `O` in it.
 *
 * One component for both the reset and the newly created account, because they
 * produce the same object under the same contract. Two copies would be two
 * places for the sentence about it being unrecoverable to rot out of.
 */
export const LawhaAdminSecret = ({
  who,
  password,
  onDone,
}: {
  who: string;
  password: string;
  onDone: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  /**
   * Absent entirely on a plain-http origin, which is what this deployment is
   * behind its gateway — browsers hand out `navigator.clipboard` only in a
   * secure context. Checked up front rather than discovered on click, so the
   * button says what it can do instead of doing nothing.
   */
  const clipboardAvailable =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Previously this set `copied` false and said nothing, so a refused
      // clipboard was a button that visibly did nothing — the silent failure
      // this codebase keeps relearning. The password is on screen in a font
      // meant to be transcribed, so the recovery is easy; it just has to be
      // said.
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <div className="lw-admin__generated" role="status">
      <span className="lw-section__title">Read this out to {who}</span>
      <input
        className="lw-admin__generated-value"
        type="text"
        readOnly
        aria-label={`Generated password for ${who}`}
        value={password}
        onFocus={(event) => event.target.select()}
      />
      <div className="lw-actions">
        {clipboardAvailable ? (
          <button type="button" className="lw-btn" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        ) : (
          // No button at all rather than one that cannot work. The field above
          // selects its whole contents on focus, so the manual path is one
          // click and Ctrl+C — which is what the hint says.
          <span className="lw-field__hint">
            Click the box above, then Ctrl+C — this browser has no clipboard
            access over plain http.
          </span>
        )}
        <button
          type="button"
          className="lw-btn lw-btn--primary"
          onClick={onDone}
        >
          Done
        </button>
      </div>
      {copyFailed ? (
        <p className="lw-inline-error" role="alert">
          The browser refused the clipboard. Click the box above and press
          Ctrl+C.
        </p>
      ) : null}
      <span className="lw-field__hint">
        Shown once. It is not stored anywhere in readable form and cannot be
        shown again — closing this is the end of it. They should change it once
        they are in.
      </span>
    </div>
  );
};
