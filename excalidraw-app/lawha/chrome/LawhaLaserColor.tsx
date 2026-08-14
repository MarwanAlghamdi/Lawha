import {
  COLLABORATOR_PALETTE,
  getCollaboratorPaletteIndex,
} from "@excalidraw/common";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { updateProfile, LawhaApiError } from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";
import { useLawhaContainer } from "../hooks/useLawhaContainer";

import { LawhaPanel } from "./LawhaPanel";

/**
 * Where each swatch sits on the wheel.
 *
 * The palette is ordered by index — indices are what the database stores, so
 * they cannot be reshuffled — but a picker ordered by index would look
 * arbitrary. Sorting a copy by hue puts the wheel back without touching the
 * storage order.
 */
const WHEEL = COLLABORATOR_PALETTE.map((entry, index) => ({ entry, index }))
  .slice()
  .sort((a, b) => a.entry.hue - b.entry.hue);

/** Radius of the ring, as a fraction of the wheel's box. */
const RING = 0.36;

/**
 * The desktop/tablet toolbar island's row of tool buttons.
 *
 * The phone's `.App-toolbar` is a different surface — the bottom bar wrapping
 * Excalidraw's `MobileToolbar` — and has no such row, so this selector finds
 * nothing there. That is deliberate: see the component below for why the phone
 * is served from the app bar's overflow sheet instead.
 */
const TOOLBAR_ROW_SELECTOR = ".App-toolbar > .Stack_horizontal";

/**
 * The toolbar's tool row, tracked as a live DOM node.
 *
 * Resolved by query rather than from a package context because there is no
 * context to read: the toolbar is unmounted and remounted whenever the form
 * factor changes, view mode is entered, or the element-link dialog opens, and
 * a host child is told about none of it.
 *
 * The effect has no dependency list on purpose, so it re-queries after every
 * commit of this component — which covers all of those cases, because the
 * component also reads `useUIAppState()` and therefore re-renders on any
 * editor state change. Comparing node identity is what stops the setState
 * from looping.
 *
 * Nothing here touches the DOM itself. `createPortal` is what moves the
 * trigger, so React owns the node's lifetime on both sides: when the target
 * changes or goes away the old subtree is unmounted rather than left behind,
 * and a missing target is `null` rather than a throw.
 */
const useToolbarRow = (container: HTMLElement | null) => {
  const [row, setRow] = useState<HTMLElement | null>(null);

  // The rule is right that a setState in a list-less effect can loop, and
  // wrong about the fix: `[container]` would only re-query when the *editor*
  // changes, which is never, while the toolbar inside it comes and goes. The
  // identity check above is what breaks the loop — the second pass computes
  // the same node and sets no state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next =
      container?.querySelector<HTMLElement>(TOOLBAR_ROW_SELECTOR) ?? null;
    setRow((current) => (current === next ? current : next));
  });

  return row;
};

interface LawhaLaserColorProps {
  /**
   * Where the trigger is rendered.
   *
   * `"toolbar"` (the default) portals it into the editor's own toolbar island,
   * at the end of the tool row, so the setting sits beside the tool it sets.
   *
   * `"inline"` renders it where it stands, which is how the phone gets it:
   * there the toolbar is Excalidraw's `MobileToolbar`, which measures itself
   * and drops its own tools into an overflow menu when space runs short — and
   * the laser is one of the tools it drops, so in the phone row there is
   * nothing for this to be beside.
   */
  placement?: "toolbar" | "inline";
}

/**
 * Laser colour, from the canvas.
 *
 * It used to live only in account settings, two navigations away from the tool
 * it configures — and it did not work: the account form marked
 * `laserColorIndex` dirty but built its PATCH body from `username` and
 * `colorIndex` only, so changing the laser colour alone sent `{}` and the
 * server answered 400 "Nothing to update".
 *
 * It then lived in the Lawha app bar, which was nearer but still not where the
 * laser is. It now mounts *inside the editor's toolbar island*, beside the
 * laser tool, and only while the laser tool is active — the way Excalidraw
 * already reveals a tool's own options. This costs nothing in `packages/`: the
 * trigger is portalled into the island's existing DOM, so invariant 10's
 * four-file divergence is untouched and there is no new extension point to
 * maintain across an upstream merge.
 *
 * Gating it on the active tool does narrow reachability — on a desktop you
 * have to pick the laser (K, or the extra-tools menu) before you can recolour
 * it. That is the right trade: the toolbar is the most contested horizontal
 * space in the app, a permanently mounted chip would widen the island on every
 * board for a preference most sessions never touch, and wanting to change the
 * laser's colour without wanting the laser is not a real state. The phone
 * sheet keeps it unconditionally, so the setting is never *only* reachable
 * through a tool selection.
 *
 * A *fixed palette laid out as a wheel*, not a continuous wheel: the value
 * that crosses the wire is a palette index, never a hex, because the
 * interactive canvas is colour-filtered in dark mode and which of an entry's
 * two hexes is correct depends on the receiver's theme.
 *
 * Nothing else has to change for the choice to take effect — `App.tsx` already
 * recomputes the local trail colour from `session.user.laserColorIndex`, and
 * `Collab` already puts the index on every pointer broadcast.
 */
export const LawhaLaserColor = ({
  placement = "toolbar",
}: LawhaLaserColorProps) => {
  const { user, setUser } = useLawhaSession();
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The open state is the component's own now. It used to be lifted into
  // LawhaTopBar, which only made sense while the bar rendered the trigger; the
  // bar no longer knows, or needs to know, where this control ends up.
  const [isOpen, setIsOpen] = useState(false);

  const { ref: mountRef, container } = useLawhaContainer<HTMLSpanElement>();
  const toolbarRow = useToolbarRow(container);

  // `useUIAppState` is the one piece of editor state a host child can read
  // that is genuinely reactive — LayerUI re-renders its provider on every
  // appState change. `useEditorInterface()` is not (invariant 6), which is
  // also why the form factor is measured rather than read from context.
  //
  // The optional chain is not decoration: the context's default value is
  // `null!`, so this would throw on `.activeTool` for a Lawha surface rendered
  // outside `<Excalidraw>`.
  const isLaserActive = useUIAppState()?.activeTool.type === "laser";

  // Two different reasons the control can be absent:
  //  - no account, so there is nowhere to save the choice to — a picker that
  //    forgets on reload is worse than not offering one;
  //  - in the toolbar it is the laser's own options, so it comes and goes with
  //    the tool.
  const isShown = Boolean(user) && (placement === "inline" || isLaserActive);

  useEffect(() => {
    // The panel belongs to the trigger. Left set while the trigger is gone,
    // `isOpen` would spring the panel open again the next time the laser is
    // picked, anchored to a button the user has not touched.
    if (!isShown) {
      setIsOpen(false);
    }
  }, [isShown]);

  // `hex`, never `hexDark`: every swatch here is DOM. Only the interactive
  // canvas is colour-filtered, and it is handed the index, not a colour.
  const hexOf = (index: number) => COLLABORATOR_PALETTE[index].hex;

  const choose = async (next: number | null) => {
    if (isSaving) {
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      setUser(await updateProfile({ laserColorIndex: next }));
    } catch (caught) {
      setError(
        caught instanceof LawhaApiError || caught instanceof Error
          ? caught.message
          : "Could not save that colour.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const fallbackIndex = user
    ? user.colorIndex ?? getCollaboratorPaletteIndex(user.id)
    : 0;
  const activeIndex = user?.laserColorIndex ?? fallbackIndex;
  const activeLabel = `Laser colour: ${COLLABORATOR_PALETTE[activeIndex].name}`;

  const panel =
    user && isShown ? (
      <LawhaPanel
        open={isOpen}
        onOpenChange={setIsOpen}
        className="lw-laser"
        ariaLabel="Laser colour"
        trigger={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            className="lw-btn lw-laser-trigger"
            aria-label={activeLabel}
            // In the toolbar the swatch is the whole button, so the name has
            // to be reachable by pointer as well as by screen reader.
            title={activeLabel}
          >
            <span
              aria-hidden="true"
              className="lw-dot lw-laser-trigger__dot"
              style={{ background: hexOf(activeIndex) }}
            />
            {placement === "inline" ? <span>Laser</span> : null}
          </button>
        )}
      >
        <div className="lw-laser__header">
          <span className="lw-laser__heading">Laser colour</span>
        </div>

        <div
          className="lw-laser__wheel"
          role="radiogroup"
          aria-label="Laser colour"
        >
          {WHEEL.map(({ entry, index }, position) => {
            // -90deg so the wheel starts at the top rather than at three
            // o'clock, which is where CSS angles begin.
            const angle = ((position / WHEEL.length) * 2 - 0.5) * Math.PI;
            const isOn = user.laserColorIndex === index;

            return (
              <button
                key={entry.name}
                type="button"
                role="radio"
                aria-checked={isOn}
                aria-label={`Laser colour: ${entry.name}`}
                title={entry.name}
                disabled={isSaving}
                className={`lw-laser__swatch${
                  isOn ? " lw-laser__swatch--on" : ""
                }`}
                style={{
                  background: entry.hex,
                  left: `${50 + RING * 100 * Math.cos(angle)}%`,
                  top: `${50 + RING * 100 * Math.sin(angle)}%`,
                }}
                onClick={() => void choose(index)}
              />
            );
          })}

          <button
            type="button"
            role="radio"
            aria-checked={user.laserColorIndex === null}
            aria-label="Laser colour: same as my cursor"
            title="Same as my cursor"
            disabled={isSaving}
            className={`lw-laser__auto${
              user.laserColorIndex === null ? " lw-laser__auto--on" : ""
            }`}
            style={{ background: hexOf(fallbackIndex) }}
            onClick={() => void choose(null)}
          >
            auto
          </button>
        </div>

        <p className="lw-laser__hint">
          {user.laserColorIndex === null
            ? "Following your cursor colour. Pick one to make the laser stand out."
            : `${COLLABORATOR_PALETTE[activeIndex].name} · pick “auto” to follow your cursor colour again.`}
        </p>

        {error ? (
          <p className="lw-inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </LawhaPanel>
    ) : null;

  if (placement === "inline") {
    return panel;
  }

  return (
    <>
      {/*
        A zero-box anchor, not a control. The portal needs a node on this side
        to find the editor container from, and walking up from our own node is
        how Lawha reaches it: the package's container context is mutated in
        place and never re-renders its consumers, so reading that would be the
        same staleness trap as invariant 6.

        `display: none` rather than an empty span, because the app bar is a
        flex row with a gap and an empty flex *item* would still contribute
        one gap.
      */}
      <span ref={mountRef} className="lw-laser-mount" aria-hidden="true" />
      {panel && toolbarRow ? createPortal(panel, toolbarRow) : null}
    </>
  );
};
