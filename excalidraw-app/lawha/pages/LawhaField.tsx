import { useId } from "react";

import type { InputHTMLAttributes, ReactNode } from "react";

interface LawhaFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  /** Mono caption under the input. Suppressed while an error is showing. */
  hint?: ReactNode;
  error?: string | null;
}

/**
 * A labelled input in the mockups' style: uppercase mono legend, 46px field.
 *
 * The label wraps the input via a generated id rather than nesting it, so the
 * error text can be associated through `aria-describedby` — a screen reader
 * otherwise announces the field and leaves the reason for the red border out.
 */
export const LawhaField = ({
  label,
  hint,
  error,
  className,
  ...inputProps
}: LawhaFieldProps) => {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={`lw-field${error ? " lw-field--invalid" : ""}`}>
      <label className="lw-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...inputProps}
        id={id}
        className={`lw-field__input${className ? ` ${className}` : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {error ? (
        <span className="lw-field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="lw-field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
};
