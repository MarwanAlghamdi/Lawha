import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAppTheme } from "../../useHandleAppTheme";
import { LawhaLogo } from "../chrome/LawhaLogo";
import { LawhaThemeToggle } from "../chrome/LawhaThemeToggle";
import { LawhaField } from "../pages/LawhaField";
import {
  LawhaPasswordField,
  isPasswordAcceptable,
} from "../pages/LawhaPasswordField";
import { LawhaPageShell } from "../pages/LawhaPageShell";

import { LawhaApiError } from "./authApi";
import { useLawhaSession } from "./useLawhaSession";

import "./LawhaAuth.scss";

export const SignUpRoute = () => {
  const navigate = useNavigate();
  const { signUp, config } = useLawhaSession();
  const { editorTheme, setAppTheme } = useAppTheme();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<LawhaApiError | Error | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const fieldError = (field: string) => {
    if (!(error instanceof LawhaApiError)) {
      return null;
    }
    if (error.field === field) {
      return error.message;
    }
    if (error.code === "USERNAME_TAKEN" && field === "username") {
      return error.message;
    }
    return null;
  };

  // Anything not attributable to a single field falls back to the form banner,
  // so a network failure is never swallowed by an unrelated input.
  const formError =
    error && !fieldError("username") && !fieldError("password")
      ? error.message
      : null;

  const canSubmit =
    username.trim().length > 0 &&
    isPasswordAcceptable(password) &&
    password === confirmPassword;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isBusy || !canSubmit) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      await signUp(username, password);
      navigate("/", { replace: true });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught
          : new Error("Could not create the account. Try again."),
      );
      setIsBusy(false);
    }
  };

  if (config?.allowOpenRegistration === false) {
    return (
      <LawhaPageShell>
        <div className="lw-auth-card">
          <div className="lw-auth-card__header">
            <LawhaLogo />
            <div className="lw-auth-card__header-spacer" />
            <LawhaThemeToggle
              editorTheme={editorTheme}
              onChange={setAppTheme}
            />
          </div>

          <div className="lw-auth-card__intro">
            <h1>Registration is closed</h1>
            <p>
              This Lawha server does not accept new accounts. Ask whoever runs
              it to create one for you.
            </p>
          </div>
          <button
            type="button"
            className="lw-btn lw-btn--primary lw-auth-card__submit"
            onClick={() => navigate("/signin")}
          >
            Back to sign in
          </button>
        </div>
      </LawhaPageShell>
    );
  }

  return (
    <LawhaPageShell>
      <form className="lw-auth-card" onSubmit={onSubmit}>
        <div className="lw-auth-card__header">
          <LawhaLogo />
          <div className="lw-auth-card__header-spacer" />
          <LawhaThemeToggle editorTheme={editorTheme} onChange={setAppTheme} />
        </div>

        <div className="lw-auth-card__intro">
          <h1>Create an account</h1>
          <p>
            Your username is what you sign in with, and what everyone sees
            beside your cursor.
          </p>
        </div>

        <div className="lw-auth-card__fields">
          {/*
            "Username", because that is what it is. The field was labelled
            "Display name" while the `name` attribute, the autocomplete hint
            and the API field were all `username` — one thing wearing two
            names, and the one the user read was the one that was not true
            anywhere else. You sign in with the name people see on your cursor.

            There is still no email field (invariant 9).
          */}
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
            error={fieldError("username")}
          />
          <LawhaPasswordField
            label="Password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            error={fieldError("password")}
            confirm
            confirmValue={confirmPassword}
            onConfirmChange={setConfirmPassword}
          />
        </div>

        {formError ? (
          <p className="lw-auth-card__error" role="alert">
            {formError}
          </p>
        ) : null}

        <button
          type="submit"
          className="lw-btn lw-btn--primary lw-auth-card__submit"
          disabled={isBusy || !canSubmit}
        >
          {isBusy ? "Creating…" : "Create account"}
        </button>

        <div className="lw-auth-card__rule" />

        <div className="lw-auth-card__alt">
          <span>Already have one?</span>
          <button
            type="button"
            className="lw-btn"
            onClick={() => navigate("/signin")}
          >
            Sign in
          </button>
        </div>
      </form>
    </LawhaPageShell>
  );
};
