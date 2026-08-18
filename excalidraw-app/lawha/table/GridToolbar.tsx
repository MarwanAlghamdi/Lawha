import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useLawhaContainer } from "../hooks/useLawhaContainer";

import {
  TOOL_HINT,
  TOOL_LABEL,
  placeTool,
  readMode,
  toolsFor,
  writeMode,
} from "./gridTools";

import "./GridToolbar.scss";

import type { ReactNode } from "react";
import type { GridMode, GridTool } from "./gridTools";

/**
 * The desktop/tablet toolbar island's row of tool buttons.
 *
 * Same target and same reasoning as `LawhaLaserColor`: the row is resolved by
 * query rather than from a package context because there is none to read, and
 * `createPortal` moves the controls so React owns their lifetime on both sides.
 * Nothing here mutates the DOM by hand, and a missing target is `null` rather
 * than a throw.
 */
const TOOLBAR_ROW_SELECTOR = ".App-toolbar > .Stack_horizontal";

const useToolbarRow = (container: HTMLElement | null) => {
  const [row, setRow] = useState<HTMLElement | null>(null);

  // No dependency list on purpose — the toolbar is unmounted and remounted
  // whenever the form factor changes or view mode is entered, and a host child
  // is told about none of it. This component reads `useUIAppState()` so it
  // re-renders on any editor state change; the identity check is what stops the
  // setState from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next =
      container?.querySelector<HTMLElement>(TOOLBAR_ROW_SELECTOR) ?? null;
    setRow((current) => (current === next ? current : next));
  });

  return row;
};

const TOOL_GLYPH: Record<GridTool, ReactNode> = {
  table: (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="3" y="4" width="14" height="12" rx="1" />
      <path d="M3 8h14M3 12h14M8 4v12M13 4v12" />
    </svg>
  ),
  code: (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
      <path d="M2.5 7.5h15" />
      <path d="M7.5 10.5L6 12l1.5 1.5M12.5 10.5L14 12l-1.5 1.5" />
    </svg>
  ),
  matrix: (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M6 4H4v12h2M14 4h2v12h-2" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  tensor2d: (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="4" y="5" width="12" height="10" rx="1" />
      <path d="M4 17.5h12M2.5 5v10" />
    </svg>
  ),
  tensor3d: (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M3 8h10v8H3z" />
      <path d="M3 8l3-3h10v8l-3 3" />
      <path d="M13 8l3-3" />
    </svg>
  ),
};

interface GridToolbarProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** Hidden entirely for a viewer — the server would refuse the write anyway. */
  canEdit: boolean;
}

/**
 * Lawha's grid tools, living in the editor's own toolbar.
 *
 * These are **not** editor tools. Registering a real `ToolType` would mean
 * editing `Tools.tsx`, both toolbars and the pointer dispatch in `App.tsx` —
 * the most expensive file in the tree to diverge (invariant 10). The editor
 * stays on its selection tool; arming one of these makes the next canvas click
 * place an object, through `onPointerDown`, which is public API.
 */
export const GridToolbar = ({ excalidrawAPI, canEdit }: GridToolbarProps) => {
  const { ref, container } = useLawhaContainer();
  // Subscribing to editor state is what makes the row re-query after the
  // toolbar remounts. The value itself is unused.
  useUIAppState();
  const row = useToolbarRow(container);

  const [mode, setMode] = useState<GridMode>(() => readMode());
  const [armed, setArmed] = useState<GridTool | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Read inside the pointer handler, which is registered once per arming. */
  const armedRef = useRef<GridTool | null>(null);
  armedRef.current = armed;

  /**
   * Place on the next canvas press.
   *
   * `originInGrid` rather than `origin` so placement honours the grid setting,
   * the way every editor tool does.
   */
  useEffect(() => {
    if (!excalidrawAPI || !armed) {
      return;
    }
    excalidrawAPI.setCursor("crosshair");

    const unsubscribe = excalidrawAPI.onPointerDown(
      (_activeTool, pointerDownState) => {
        const tool = armedRef.current;
        if (!tool) {
          return;
        }
        const at = pointerDownState.originInGrid ?? pointerDownState.origin;
        const { elements: fresh, file } = placeTool(tool, at);
        if (fresh.length === 0) {
          return;
        }

        // The file first, always. An image element whose file the editor has
        // not seen yet renders as a broken placeholder, and the scene update
        // below is what makes the element visible — so the order matters.
        if (file) {
          excalidrawAPI.addFiles([file]);
        }

        excalidrawAPI.updateScene({
          elements: [
            ...excalidrawAPI.getSceneElements(),
            ...fresh,
          ] as ExcalidrawElement[],
          appState: {
            // One cell, not all of them. Cells are ungrouped, so selecting the
            // whole set would paint an outline around every one of them — the
            // "twelve things" look this design exists to avoid. Selecting a
            // single cell is enough for the overlay to find the table and offer
            // its move bar and row/column handles.
            selectedElementIds: { [fresh[0]!.id]: true },
            selectedGroupIds: {},
          },
          // One insert is one undo step. The default is
          // `CaptureUpdateAction.EVENTUALLY`, which folds the insert into some
          // later increment — so Ctrl+Z took away part of something else and
          // left the table behind.
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });

        // Revert to selection, unless the toolbar's lock is engaged — the same
        // contract every editor tool honours.
        if (!excalidrawAPI.getAppState().activeTool.locked) {
          setArmed(null);
        }
      },
    );

    return () => {
      unsubscribe();
      excalidrawAPI.resetCursor();
    };
  }, [excalidrawAPI, armed]);

  /** Escape disarms, like every other transient mode in the editor. */
  useEffect(() => {
    if (!armed) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setArmed(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [armed]);

  const chooseMode = (next: GridMode) => {
    setMode(next);
    writeMode(next);
    setMenuOpen(false);
    // Leaving a tool armed that the new mode no longer offers would leave the
    // cursor as a crosshair with nothing behind it.
    if (!toolsFor(next).includes(armed as GridTool)) {
      setArmed(null);
    }
  };

  /**
   * The anchor renders unconditionally, and that is load-bearing.
   *
   * `useLawhaContainer` finds `.excalidraw` by walking up from this node, and
   * `useToolbarRow` queries that container for the row. Returning early when
   * the row is not yet known would unmount the very node the lookup depends on
   * — the first pass finds no row, renders nothing, and there is then no anchor
   * for the second pass to walk up from. It never resolves.
   */
  return (
    <>
      <span ref={ref} className="lw-grid-anchor" aria-hidden="true" />
      {row && canEdit
        ? createPortal(
            <>
              <div className="App-toolbar__divider lw-grid-divider" />
              {toolsFor(mode).map((tool) => (
                <button
                  key={tool}
                  type="button"
                  className={`ToolIcon ToolIcon_type_toggle ToolIcon_size_medium lw-grid-tool${
                    armed === tool ? " ToolIcon--checked" : ""
                  }`}
                  title={TOOL_HINT[tool]}
                  aria-label={TOOL_LABEL[tool]}
                  aria-pressed={armed === tool}
                  data-testid={`lawha-tool-${tool}`}
                  onClick={() => setArmed(armed === tool ? null : tool)}
                >
                  <div className="ToolIcon__icon">{TOOL_GLYPH[tool]}</div>
                </button>
              ))}

              <div className="lw-grid-mode">
                <button
                  type="button"
                  className="lw-grid-mode__trigger"
                  title="Toolbar mode"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-testid="lawha-mode-trigger"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  {mode === "datascience" ? "DS" : "Std"}
                  <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    className="lw-grid-mode__caret"
                  >
                    <path
                      d="M6 8l4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {menuOpen ? (
                  <div className="lw-grid-mode__menu" role="menu">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode === "standard"}
                      data-testid="lawha-mode-standard"
                      onClick={() => chooseMode("standard")}
                    >
                      <strong>Standard</strong>
                      <span>Tables, and the usual shapes.</span>
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode === "datascience"}
                      data-testid="lawha-mode-datascience"
                      onClick={() => chooseMode("datascience")}
                    >
                      <strong>Data science</strong>
                      <span>Adds matrices and tensor blocks.</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </>,
            row,
          )
        : null}
    </>
  );
};
