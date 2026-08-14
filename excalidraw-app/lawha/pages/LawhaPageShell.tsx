import { useAppTheme } from "../../useHandleAppTheme";
import { LawhaLogo } from "../chrome/LawhaLogo";
import { LawhaThemeToggle } from "../chrome/LawhaThemeToggle";

import "./LawhaPageShell.scss";

import type { ReactNode } from "react";

interface LawhaPageShellProps {
  children: ReactNode;
  /** Renders the back affordance on the left of the header row. */
  back?: { label: string; onClick: () => void };
  /** Small mono caption sitting beside the back link. */
  caption?: string;
  /** Centres a narrow card (auth) rather than laying out a full page (account). */
  variant?: "card" | "page";
}

/**
 * The chrome shared by every screen that is *not* the canvas.
 *
 * Only Home, Sign In and Sign Up were excluded from the consolidation
 * requirement, so this shell exists for those — a dotted backdrop, the brand
 * lockup, and a theme toggle. It deliberately reproduces the mockups' backdrop
 * rather than reusing the editor's, because there is no editor here to inherit
 * from.
 *
 * The page-level header row (logo/back, caption, toggle) renders for the `page`
 * variant — that is how the Account mockup does it — and for anything that asks
 * for a back affordance. Sign in and sign up do neither: they put the brand
 * lockup and toggle *inside* the card as its own first row, which is why
 * nothing is rendered here for them. See `.lw-auth-card__header`.
 *
 * The `back` half of that condition is load-bearing. Gating on the variant
 * alone silently removed the "All boards" button from the locked-board panel,
 * which is a `card` — leaving anyone who opened a board they hold no key for
 * with no way back to the dashboard. Every test passed; nothing covered it.
 */
export const LawhaPageShell = ({
  children,
  back,
  caption,
  variant = "card",
}: LawhaPageShellProps) => {
  const { editorTheme, setAppTheme } = useAppTheme();

  return (
    <div className={`lw-page lw-page--${variant}`}>
      {/* The 26px dot grid from the mockups; decorative, hence aria-hidden. */}
      <div className="lw-page__backdrop" aria-hidden="true" />

      <div className="lw-page__body">
        {variant === "page" || back ? (
          <header className="lw-page__header">
            {back ? (
              <button type="button" className="lw-btn" onClick={back.onClick}>
                <span aria-hidden="true">←</span>
                <span>{back.label}</span>
              </button>
            ) : (
              <LawhaLogo />
            )}

            {caption ? (
              <span className="lw-page__caption">{caption}</span>
            ) : null}

            <div className="lw-page__spacer" />

            <LawhaThemeToggle
              editorTheme={editorTheme}
              onChange={setAppTheme}
            />
          </header>
        ) : null}

        <main className="lw-page__main">{children}</main>
      </div>
    </div>
  );
};
