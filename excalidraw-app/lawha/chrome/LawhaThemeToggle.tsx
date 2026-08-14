import { THEME } from "@excalidraw/excalidraw";

import type { Theme } from "@excalidraw/element/types";

interface LawhaThemeToggleProps {
  editorTheme: Theme;
  onChange: (theme: Theme) => void;
  compact?: boolean;
}

/**
 * The mockup's half-filled circle glyph: a ring with an inset shadow filling
 * one side. Drawn in CSS rather than shipped as an icon so it inherits
 * currentColor.
 */
const ThemeGlyph = () => <span className="lw-theme-glyph" aria-hidden="true" />;

/**
 * Theme switch for the pages outside the editor.
 *
 * **The label names the theme you are in, not the one you would move to.** It
 * read the other way round until it was pointed out that a control sitting on a
 * dark surface and saying "Light" is ambiguous — it could as easily be
 * describing itself as offering a change. A state readout is unambiguous, and
 * `aria-pressed` says the same thing to a screen reader.
 *
 * Inside the canvas there is no toggle at all: theme lives in the editor's own
 * main menu, next to the system-theme option this control cannot offer.
 */
export const LawhaThemeToggle = ({
  editorTheme,
  onChange,
  compact,
}: LawhaThemeToggleProps) => {
  const isDark = editorTheme === THEME.DARK;
  const next = isDark ? THEME.LIGHT : THEME.DARK;

  return (
    <button
      type="button"
      className={`lw-btn lw-theme-toggle${
        isDark ? " lw-theme-toggle--dark" : ""
      }`}
      onClick={() => onChange(next)}
      title={`Dark mode is ${isDark ? "on" : "off"} — switch to ${next}`}
      aria-pressed={isDark}
      aria-label={`Dark mode, currently ${isDark ? "on" : "off"}`}
    >
      <ThemeGlyph />
      {compact ? null : <span>{isDark ? "Dark" : "Light"}</span>}
    </button>
  );
};
