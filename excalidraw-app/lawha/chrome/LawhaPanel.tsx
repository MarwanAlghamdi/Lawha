import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef } from "react";

import { useLawhaContainer } from "../hooks/useLawhaContainer";
import { useLawhaFormFactor } from "../hooks/useLawhaFormFactor";

import "./LawhaPanel.scss";

import type { ReactNode, RefObject } from "react";

export interface LawhaPanelTriggerProps {
  onClick?: () => void;
  "aria-expanded"?: boolean;
}

interface LawhaPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Renders the button. Given props on the sheet path, and nothing on the
   * popover path — there Radix injects its own through `asChild`, and a second
   * onClick would toggle the panel twice per press.
   */
  trigger: (props: LawhaPanelTriggerProps) => ReactNode;
  children: ReactNode;
  /** Base class for the panel surface, e.g. `lw-ai`. `--sheet` is appended. */
  className: string;
  ariaLabel: string;
}

const SHEET_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every phone sheet currently open, most recently opened last.
 *
 * Module-scoped rather than component state, because it exists only to
 * answer one question inside a `keydown` listener that fires outside any
 * particular sheet's render: "am I the topmost sheet right now". Sheets
 * nest — `LawhaTopBar`'s board-options sheet renders `LawhaSharePopover`,
 * `LawhaAIMenu` and `LawhaLaserColor` inside itself, and every one of those
 * opens as its own phone sheet in the very same DOM subtree, because
 * invariant 11 rules out a portal to separate them. Every sheet listens for
 * Escape on `document`, so without a notion of "topmost" the outer sheet's
 * listener — registered first, since it opened first — would answer a key
 * meant for the inner one, closing both in a single keystroke.
 */
const openLawhaSheets: symbol[] = [];

/**
 * Escape-to-close, a Tab trap and focus restore for a phone bottom sheet.
 *
 * None of this comes for free the way it would from a dialog primitive:
 * every sheet in the app is rendered directly into the editor container
 * rather than through Radix (invariant 11), and it is Radix's own
 * `Dialog`/`Popover` content that would otherwise supply this trio. Shared
 * by every sheet — this file's own phone branch below, and
 * `LawhaTopBar.tsx`'s board-options sheet, which is not built on this
 * component — rather than copied twice, because a focus trap copied by hand
 * is exactly the kind of code that drifts the second time somebody edits one
 * copy and not the other.
 */
export const useLawhaSheet = (
  active: boolean,
  onClose: () => void,
): RefObject<HTMLDivElement | null> => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  // A stable identity for this sheet's slot in `openLawhaSheets`, so closing
  // and reopening the same sheet is still told apart from another one.
  const token = useRef(Symbol("lawha-sheet"));

  const focusables = useCallback((): HTMLElement[] => {
    const sheet = sheetRef.current;
    return sheet
      ? Array.from(sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)).filter(
          (node) =>
            node.offsetParent !== null || node === document.activeElement,
        )
      : [];
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    // Copied out of the ref for the cleanup below: `token.current` is never
    // reassigned after this ref is created, but the lint rule has no way to
    // know that, and closing over the variable rather than the ref is the
    // fix it asks for either way.
    const mySheet = token.current;
    openLawhaSheets.push(mySheet);
    // Whatever had focus before the sheet opened — ordinarily the trigger
    // that was just tapped — so it can have focus back on close.
    returnTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // The first actionable control, matching the desktop popover's own
    // `onOpenAutoFocus` a few lines down: landing on the sheet itself is a
    // fallback for a sheet with nothing tabbable ahead of it, not the goal.
    const first = focusables()[0];
    (first ?? sheetRef.current)?.focus();

    return () => {
      const index = openLawhaSheets.indexOf(mySheet);
      if (index !== -1) {
        openLawhaSheets.splice(index, 1);
      }
      returnTo.current?.focus();
    };
  }, [active, focusables]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // A sheet whose own div never mounted (or has already unmounted) has
      // nothing to trap focus inside of, and answering here would only block
      // Tab everywhere for no dialog anybody can see.
      if (!sheetRef.current) {
        return;
      }
      // Only the topmost sheet answers — see `openLawhaSheets` above.
      if (openLawhaSheets[openLawhaSheets.length - 1] !== token.current) {
        return;
      }

      if (event.key === "Escape") {
        // Capture phase, same reason as `account/LawhaAccountDialog.tsx`: the
        // editor's own keydown listeners are on `document` too, and bubbling
        // would let them run first — an un-stopped Escape here would also
        // deselect on the canvas behind the sheet.
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }

      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active2 = document.activeElement;

      if (
        event.shiftKey &&
        (active2 === first || active2 === sheetRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active2 === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, onClose, focusables]);

  return sheetRef;
};

/**
 * A control whose panel is an anchored popover on a pointer-and-space device
 * and a bottom sheet on a phone.
 *
 * The two are built differently on purpose. A phone sheet is **not** rendered
 * through Radix, because Radix positions its content inside a wrapper carrying
 * a `transform` — and a transformed ancestor becomes the containing block for
 * `position: fixed` descendants. A sheet styled `position: fixed; inset-inline:
 * 0` therefore stretches to the wrapper's zero-width box rather than to the
 * viewport, and lands off-screen at a few pixels wide. That was a live bug in
 * the share popover before this component existed.
 *
 * Anchoring is also the wrong idea for a sheet: it has no anchor. It is pinned
 * to the bottom of the screen, so it needs no popper at all.
 *
 * Both forms stay inside `.excalidraw-container` — the popover by portalling
 * there explicitly, the sheet by simply being rendered there.
 */
export const LawhaPanel = ({
  open,
  onOpenChange,
  trigger,
  children,
  className,
  ariaLabel,
}: LawhaPanelProps) => {
  const { ref, container } = useLawhaContainer<HTMLDivElement>();
  // Measured locally rather than read from EditorInterfaceContext; see
  // useLawhaFormFactor for why that context can be stale for host children.
  const { ref: formFactorRef, formFactor } = useLawhaFormFactor();
  const isPhone = formFactor === "phone";
  // Gated on `isPhone` too, not just `open`: `open` also drives the desktop
  // Radix popover below, and this hook's own sheet div never mounts there —
  // without the extra check its Tab trap would see zero focusable nodes on
  // every desktop popover open and block Tab globally for no dialog visible
  // anywhere.
  const sheetRef = useLawhaSheet(open && isPhone, () => onOpenChange(false));

  const setAnchorRef = (node: HTMLDivElement | null) => {
    ref.current = node;
    formFactorRef(node);
  };

  if (isPhone) {
    return (
      <div ref={setAnchorRef} className={`${className}-anchor`}>
        {trigger({
          onClick: () => onOpenChange(!open),
          "aria-expanded": open,
        })}

        {open ? (
          <>
            <button
              type="button"
              className="lw-sheet-scrim"
              aria-label={`Close ${ariaLabel}`}
              onClick={() => onOpenChange(false)}
            />
            <div
              ref={sheetRef}
              className={`${className} ${className}--sheet`}
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              tabIndex={-1}
            >
              {children}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={setAnchorRef} className={`${className}-anchor`}>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>{trigger({})}</Popover.Trigger>

        <Popover.Portal container={container ?? undefined}>
          <Popover.Content
            className={className}
            side="bottom"
            align="end"
            sideOffset={12}
            collisionPadding={14}
            aria-label={ariaLabel}
            onOpenAutoFocus={(event) => {
              // Land on something actionable rather than the panel itself.
              // `:not([disabled])` matters for the AI panel, where every
              // feature row is disabled and only the close button can take
              // focus — Radix's default would land on the container.
              event.preventDefault();
              (event.currentTarget as HTMLElement)
                .querySelector<HTMLElement>(
                  "input:not([disabled]), button:not([disabled])",
                )
                ?.focus();
            }}
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};
