import { useId, useState } from "react";

/** Mirrors passwordSchema in lawha-server/src/lib/validation.ts. */
export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordRule {
  label: string;
  met: boolean;
}

/** Length is the only rule, and it is the same one the server applies. */
export const checkPassword = (value: string): PasswordRule[] => [
  {
    label: `at least ${MIN_PASSWORD_LENGTH} characters`,
    met: value.length >= MIN_PASSWORD_LENGTH,
  },
];

export const isPasswordAcceptable = (value: string): boolean =>
  checkPassword(value).every((rule) => rule.met);

interface LawhaPasswordFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "new-password" | "current-password";
  error?: string | null;
  autoFocus?: boolean;
  /** Second field that must match. Off for sign-in, on when setting one. */
  confirm?: boolean;
  confirmValue?: string;
  onConfirmChange?: (value: string) => void;
  /**
   * Drops `required`, for the one caller where blank means something.
   *
   * The administration panel's "create an account" form treats an empty
   * password as "generate one for me", which is the common case there. With
   * `required` on, the browser's own constraint validation refuses to fire
   * the form's submit event at all — so the feature could not work, and the
   * failure was silent: the button looked live and clicking it did nothing.
   *
   * Default off, because every other caller genuinely does need a value and a
   * field that silently stopped being required would be the worse mistake.
   */
  optional?: boolean;
}

/**
 * A password input that states its rules.
 *
 * The rules were always enforced — the server rejects a short password with a
 * 400 and the browser blocks submission on `minLength` — but neither says
 * anything until you have already tried. An invisible constraint reads as no
 * constraint, which is exactly the impression this is here to correct: the
 * checklist is visible from the first keystroke and ticks off as you type.
 *
 * Sign-in deliberately gets none of this. Applying today's rules to a password
 * chosen under yesterday's would lock people out of their own accounts.
 */
export const LawhaPasswordField = ({
  label,
  name,
  value,
  onChange,
  autoComplete,
  error,
  autoFocus,
  confirm,
  confirmValue = "",
  onConfirmChange,
  optional = false,
}: LawhaPasswordFieldProps) => {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const rules = checkPassword(value);
  const showRules = confirm && (touched || value.length > 0);
  const mismatch =
    confirm && confirmValue.length > 0 && confirmValue !== value
      ? "Both entries must match."
      : null;

  return (
    <>
      <div className={`lw-field${error ? " lw-field--invalid" : ""}`}>
        <label className="lw-field__label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          name={name}
          type="password"
          className="lw-field__input"
          autoComplete={autoComplete}
          placeholder="••••••••"
          required={!optional}
          autoFocus={autoFocus}
          minLength={confirm ? MIN_PASSWORD_LENGTH : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={error ? true : undefined}
          // Three-way, not two-way, since the hint below was deleted. It used
          // to be `error ? error-id : rules-id`, and the `rules` id was always
          // present because the `else` branch rendered a hint to carry it.
          // With that gone, the two-way version would point at an element that
          // does not exist on the sign-in form — a dangling `aria-describedby`
          // is worse than none, because a screen reader announces nothing and
          // there is no way to tell from the outside that it was meant to.
          aria-describedby={
            error ? `${id}-error` : showRules ? `${id}-rules` : undefined
          }
        />
        {error ? (
          <span className="lw-field__error" id={`${id}-error`} role="alert">
            {error}
          </span>
        ) : null}

        {/*
          No `else` branch any more. It carried "hashed with argon2id · never
          stored in the clear", which was a true statement about the server's
          internals placed where somebody is trying to think of a password —
          it asked the reader to evaluate a claim they have no way to check,
          in exchange for nothing they can act on. Sign-in rendered it
          permanently and loses it too, which is the same improvement.
        */}
        {showRules ? (
          <ul className="lw-rules" id={`${id}-rules`}>
            {rules.map((rule) => (
              <li
                key={rule.label}
                className={rule.met ? "lw-rules__item--met" : undefined}
              >
                {/* The tick is decorative; `met` is already in the text
                    colour and, for a screen reader, in the label below. */}
                <span aria-hidden="true">{rule.met ? "✓" : "○"}</span>
                <span>{rule.label}</span>
                <span className="lw-visually-hidden">
                  {rule.met ? " — met" : " — not yet met"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {confirm ? (
        <div className={`lw-field${mismatch ? " lw-field--invalid" : ""}`}>
          <label className="lw-field__label" htmlFor={`${id}-confirm`}>
            Confirm password
          </label>
          <input
            id={`${id}-confirm`}
            name={`${name}Confirm`}
            type="password"
            className="lw-field__input"
            autoComplete="new-password"
            placeholder="••••••••"
            required={!optional}
            value={confirmValue}
            onChange={(event) => onConfirmChange?.(event.target.value)}
            aria-invalid={mismatch ? true : undefined}
          />
          {mismatch ? (
            <span className="lw-field__error" role="alert">
              {mismatch}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
};
