import { getFormFactor } from "@excalidraw/common";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { EditorInterface } from "@excalidraw/common";

// The package exposes the union through EditorInterface rather than by name.
type FormFactor = EditorInterface["formFactor"];

/**
 * The editor's form factor, measured locally.
 *
 * Not `useEditorInterface()`, despite that being the obvious choice:
 * `App.refreshEditorInterface` assigns to a plain instance field rather than
 * React state, so `EditorInterfaceContext` only carries the new value on the
 * *next* App render. A host child that reads the context on mount can therefore
 * be left showing the wrong layout indefinitely — which is exactly what
 * happened here, with the desktop bar rendering at 390px.
 *
 * Measuring the editor container directly and re-rendering from a
 * ResizeObserver removes the dependency on when App happens to render. It uses
 * the package's own `getFormFactor`, so the breakpoints cannot drift from the
 * ones `MobileMenu` and the styles panel use.
 */
export const useLawhaFormFactor = (): {
  ref: (node: HTMLElement | null) => void;
  formFactor: FormFactor;
} => {
  const [formFactor, setFormFactor] = useState<FormFactor>("desktop");
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    const container = node?.closest<HTMLElement>(".excalidraw");
    if (!container) {
      return;
    }

    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      // A zero-size box means the editor has not been laid out yet (jsdom, or
      // a display:none ancestor). Measuring it would report "phone" for
      // everything, so leave the current value alone.
      if (width === 0 && height === 0) {
        return;
      }
      setFormFactor(getFormFactor(width, height));
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(container);
  }, []);

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  return { ref, formFactor };
};
