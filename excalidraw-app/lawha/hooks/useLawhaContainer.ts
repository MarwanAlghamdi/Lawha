import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Finds the enclosing `.excalidraw` element.
 *
 * Lawha chrome renders as a child of `<Excalidraw>`, so it lives inside the
 * editor container but has no direct reference to it — `useExcalidrawContainer`
 * is internal to the package. Walking up from our own node is the supported
 * way to reach it, and it is what lets popovers portal *inside* the editor
 * rather than to document.body.
 */
export const useLawhaContainer = <T extends HTMLElement = HTMLDivElement>() => {
  const ref = useRef<T | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setContainer(ref.current?.closest<HTMLElement>(".excalidraw") ?? null);
  }, []);

  return { ref, container };
};

/**
 * Publishes an element's measured height onto the editor container as a CSS
 * custom property, so stylesheets can reserve space for it.
 *
 * A measured value rather than a constant because the top bar wraps to a second
 * row on narrow viewports — the mockups have no media queries and rely entirely
 * on intrinsic layout, so its height is genuinely not known ahead of time.
 */
export const usePublishedHeight = (
  property: string,
): {
  ref: (node: HTMLElement | null) => void;
} => {
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();

      if (!node) {
        containerRef.current?.style.removeProperty(property);
        containerRef.current = null;
        return;
      }

      const container = node.closest<HTMLElement>(".excalidraw");
      containerRef.current = container;
      if (!container) {
        return;
      }

      const publish = () => {
        container.style.setProperty(
          property,
          `${Math.round(node.getBoundingClientRect().height)}px`,
        );
      };

      publish();

      // Degrade to a single measurement where ResizeObserver is unavailable.
      // The published height is then correct but static, which is a cosmetic
      // loss (the bar would not re-measure when it wraps) rather than a break.
      if (typeof ResizeObserver === "undefined") {
        return;
      }

      observerRef.current = new ResizeObserver(publish);
      observerRef.current.observe(node);
    },
    [property],
  );

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
      containerRef.current?.style.removeProperty(property);
    },
    [property],
  );

  return { ref };
};
