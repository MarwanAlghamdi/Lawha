import { ExcalidrawAPIProvider } from "@excalidraw/excalidraw";

import { Provider, appJotaiStore } from "../app-jotai";
import { TopErrorBoundary } from "../components/TopErrorBoundary";
import { AppThemeProvider } from "../useHandleAppTheme";

import type { ReactNode } from "react";

/**
 * Everything that must outlive a navigation.
 *
 * The jotai store in particular: the collaboration atoms, the session, and the
 * save status all hang off it, and a store scoped inside a route would be torn
 * down and rebuilt every time the user opened account settings.
 */
export const LawhaProviders = ({ children }: { children: ReactNode }) => (
  <TopErrorBoundary>
    <Provider store={appJotaiStore}>
      <ExcalidrawAPIProvider>
        <AppThemeProvider>{children}</AppThemeProvider>
      </ExcalidrawAPIProvider>
    </Provider>
  </TopErrorBoundary>
);
