import { useEffect, useRef, useState } from "react";

import {
  FONT_FAMILY,
  getFontFamilyString,
  sceneCoordsToViewportCoords,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";
import { parseDims } from "@excalidraw/element";

import type { Radians } from "@excalidraw/math";
import type { ExcalidrawTensorElement } from "@excalidraw/element/types";

import { t } from "../i18n";

import type { AppState } from "../types";

/**
 * LAWHA: edit a tensor's shape where the tensor is.
 *
 * The properties panel can set the shape too, but double-clicking the thing
 * you want to change is the gesture everyone tries first — and on this block
 * the numbers *are* the content, the way a cell's text is a table's content.
 * Falling through to Excalidraw's text binding instead would staple a loose
 * label onto the block, which is the composed-object mistake this rewrite
 * exists to undo.
 */

interface TensorDimsEditorProps {
  element: ExcalidrawTensorElement;
  appState: AppState;
  onChange: (element: ExcalidrawTensorElement, dims: number[]) => void;
  onClose: () => void;
}

export const TensorDimsEditor = ({
  element,
  appState,
  onChange,
  onClose,
}: TensorDimsEditorProps) => {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(element.dims.join(" × "));

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const zoom = appState.zoom.value;
  const centre = pointRotateRads(
    pointFrom(element.x + element.width / 2, element.y + element.height / 2),
    pointFrom(element.x + element.width / 2, element.y + element.height / 2),
    element.angle as Radians,
  );
  const { x: viewX, y: viewY } = sceneCoordsToViewportCoords(
    { sceneX: centre[0], sceneY: centre[1] },
    appState,
  );

  const commit = (value: string) => {
    const dims = parseDims(value);
    // An unparseable draft leaves the shape alone rather than collapsing the
    // block to nothing — you are mid-edit, not asking for an empty tensor.
    if (dims.length) {
      onChange(element, dims);
    }
    onClose();
  };

  return (
    <input
      ref={ref}
      type="text"
      className="excalidraw-tensor-dims-editor"
      value={draft}
      aria-label={t("labels.tensorShape")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit(event.currentTarget.value);
          return;
        }
        if (event.key === "Escape") {
          onClose();
        }
      }}
      style={{
        position: "absolute",
        left: `${viewX - appState.offsetLeft}px`,
        top: `${viewY - appState.offsetTop}px`,
        transform: "translate(-50%, -50%)",
        width: `${Math.max(120, element.width * 0.7) * zoom}px`,
        padding: `${6 * zoom}px ${8 * zoom}px`,
        textAlign: "center",
        border: "none",
        outline: "2px solid var(--color-primary)",
        borderRadius: `${4 * zoom}px`,
        background: "var(--island-bg-color)",
        color: element.strokeColor,
        fontFamily: getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia }),
        fontSize: `${14 * zoom}px`,
        zIndex: 2,
      }}
      dir="ltr"
      autoComplete="off"
      spellCheck={false}
    />
  );
};
