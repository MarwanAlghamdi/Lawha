import { THEME } from "@excalidraw/excalidraw";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

import type { Theme } from "@excalidraw/element/types";

import { STORAGE_KEYS } from "./app_constants";

import type { ReactNode } from "react";

const getDarkThemeMediaQuery = (): MediaQueryList | undefined =>
  window.matchMedia?.("(prefers-color-scheme: dark)");

export const useHandleAppTheme = () => {
  const [appTheme, setAppTheme] = useState<Theme | "system">(() => {
    return (
      (localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME) as
        | Theme
        | "system"
        | null) || THEME.LIGHT
    );
  });
  const [editorTheme, setEditorTheme] = useState<Theme>(THEME.LIGHT);

  useEffect(() => {
    const mediaQuery = getDarkThemeMediaQuery();

    const handleChange = (e: MediaQueryListEvent) => {
      setEditorTheme(e.matches ? THEME.DARK : THEME.LIGHT);
    };

    if (appTheme === "system") {
      mediaQuery?.addEventListener("change", handleChange);
    }

    return () => {
      mediaQuery?.removeEventListener("change", handleChange);
    };
  }, [appTheme]);

  useLayoutEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, appTheme);

    if (appTheme === "system") {
      setEditorTheme(
        getDarkThemeMediaQuery()?.matches ? THEME.DARK : THEME.LIGHT,
      );
    } else {
      setEditorTheme(appTheme);
    }
  }, [appTheme]);

  // Mirror the resolved theme onto <body> so the Lawha tokens resolve on pages
  // that live outside the editor (home, sign in, account). Inside the editor
  // the same palettes hang off `.excalidraw.theme--dark`, which the Excalidraw
  // component toggles itself — driving both from here keeps them in step
  // without a second persisted preference.
  useLayoutEffect(() => {
    document.body.dataset.lwTheme = editorTheme;
  }, [editorTheme]);

  return { editorTheme, appTheme, setAppTheme };
};

export type AppThemeState = ReturnType<typeof useHandleAppTheme>;

const AppThemeContext = createContext<AppThemeState | null>(null);

/**
 * Hoists the theme above the router so it survives navigation.
 *
 * Sign in, the account page, and the canvas are separate routes, so only one of
 * them is mounted at a time. Calling the hook per route would give each its own
 * state, and the theme would visibly reset on every navigation even though the
 * stored preference never changed.
 */
export const AppThemeProvider = ({ children }: { children: ReactNode }) =>
  createElement(
    AppThemeContext.Provider,
    { value: useHandleAppTheme() },
    children,
  );

export const useAppTheme = (): AppThemeState => {
  const value = useContext(AppThemeContext);
  if (!value) {
    throw new Error("useAppTheme must be used inside <AppThemeProvider>");
  }
  return value;
};
