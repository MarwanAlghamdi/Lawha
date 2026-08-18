import { DEFAULT_TRANSFORM_HANDLE_SPACING } from "@excalidraw/common";
import {
  ANCHOR_THICKNESS,
  anchorStrip,
  getCellRect,
  gridLines,
  plusButtons,
  tableColCount,
  tableRowCount,
} from "@excalidraw/element";
import { getElementAbsoluteCoords } from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawTableElement,
} from "@excalidraw/element/types";

import { roundRect } from "./roundRect";

import type { InteractiveCanvasAppState } from "../types";
import type { InteractiveCanvasRenderConfig } from "../scene/types";

/**
 * LAWHA: the interior chrome of a table — row and column anchors, the divider
 * being dragged, the bulk selection, the active cell, and the hover-revealed
 * buttons that add a row or column.
 *
 * Kept out of `interactiveScene.ts` so that file gains an import and one call
 * rather than two hundred lines: `packages/` is upstream, and the cheapest
 * change there is the one a merge never has to read.
 *
 * Every rule below comes from what upstream already does, not from taste:
 * `1 / zoom` strokes, white-filled handles with a `selectionColor` border at
 * full opacity, `2 / zoom` corner radii, an explicit `setLineDash` at every
 * stroke site, and a `|| "#000"` colour fallback because `getPropertyValue`
 * returns `""` before the container is styled and assigning `""` to
 * `strokeStyle` is a silent no-op.
 *
 * One deliberate divergence, and it is worth naming. Upstream's transform
 * handles do NOT rotate — `generateTransformHandle` rotates only the handle's
 * centre and returns an axis-aligned box — because they are points, and a
 * point has no orientation to lose. An anchor is not a point: it spans the
 * column it addresses, so an axis-aligned strip over a rotated table would
 * detach from the column it names. These rotate with the element, like the
 * binding highlight does.
 */

/** Alpha for the wash over a bulk-selected row or column. */
const BULK_FILL_ALPHA = 0.1;

export const renderTableHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
): void => {
  // Upstream hides transform handles for a locked element so the lock reads as
  // a lock. Interior handles that stayed would say the opposite.
  if (element.locked) {
    return;
  }

  const editor =
    appState.editingTableElement?.elementId === element.id
      ? appState.editingTableElement
      : null;
  const zoom = appState.zoom.value;
  const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
  const color = renderConfig.selectionColor || "#000";
  const radius = 2 / zoom;

  const { xs, ys } = gridLines(element);
  const cols = tableColCount(element);
  const rows = tableRowCount(element);
  const selection = editor?.selection ?? null;
  const isSelected = (axis: "col" | "row", index: number) =>
    selection?.axis === axis && selection.indices.includes(index);

  // Anchors and the add buttons are revealed by hovering the element, the way
  // Notion reveals its grips — a table at rest should look like a table, not
  // like a table wearing equipment.
  const revealed = editor?.isHovered === true || selection !== null;

  context.save();
  // Element-local frame, so a rotated table keeps its chrome welded to it.
  context.translate(cx, cy);
  context.rotate(element.angle);
  context.translate(-cx, -cy);
  context.translate(element.x, element.y);

  context.lineWidth = 1 / zoom;
  context.setLineDash([]);

  // The wash over a bulk selection, drawn first so the rules stay legible
  // through it. 0.1 is in upstream's existing alpha vocabulary; the 0.12 this
  // used to be was invented.
  if (selection) {
    context.save();
    context.globalAlpha *= BULK_FILL_ALPHA;
    context.fillStyle = color;
    for (const index of selection.indices) {
      if (selection.axis === "col" && index < cols) {
        context.fillRect(
          xs[index]!,
          ys[0]!,
          xs[index + 1]! - xs[index]!,
          ys[ys.length - 1]! - ys[0]!,
        );
      } else if (selection.axis === "row" && index < rows) {
        context.fillRect(
          xs[0]!,
          ys[index]!,
          xs[xs.length - 1]! - xs[0]!,
          ys[index + 1]! - ys[index]!,
        );
      }
    }
    context.restore();
  }

  const drawHandle = (
    x: number,
    y: number,
    width: number,
    height: number,
    selected: boolean,
  ) => {
    // Upstream's handle: white fill, `selectionColor` border, full opacity.
    context.fillStyle = selected ? color : "#fff";
    context.strokeStyle = color;
    roundRect(context, x, y, width, height, radius, color);
  };

  if (revealed) {
    for (let i = 0; i < cols; i++) {
      const strip = anchorStrip(element, "col", i, zoom, "mouse");
      if (strip) {
        drawHandle(
          strip.x,
          strip.y,
          strip.width,
          strip.height,
          isSelected("col", i),
        );
      }
    }
    for (let i = 0; i < rows; i++) {
      const strip = anchorStrip(element, "row", i, zoom, "mouse");
      if (strip) {
        drawHandle(
          strip.x,
          strip.y,
          strip.width,
          strip.height,
          isSelected("row", i),
        );
      }
    }

    // The add-a-row and add-a-column buttons, at the trailing edge where you
    // are already looking when you run out of grid — Notion's move, and the
    // reason nobody goes to a side panel to add a row.
    const size = ANCHOR_THICKNESS / zoom;
    for (const button of plusButtons(element, zoom, "mouse")) {
      drawHandle(button.x, button.y, button.width, button.height, false);
      context.strokeStyle = color;
      context.beginPath();
      const midX = button.x + button.width / 2;
      const midY = button.y + button.height / 2;
      const arm = size * 0.28;
      context.moveTo(midX - arm, midY);
      context.lineTo(midX + arm, midY);
      context.moveTo(midX, midY - arm);
      context.lineTo(midX, midY + arm);
      context.stroke();
    }
  }

  // The divider under the cursor, or the one being dragged. Only one, and only
  // while it is relevant — a table permanently outlined in accent colour is
  // noise. Dashed while hovering, solid while dragging, so the two states are
  // distinguishable without colour.
  const dragging = editor?.draggingDivider ?? null;
  const divider = dragging ?? editor?.hoveredDivider ?? null;

  if (divider) {
    context.save();
    context.strokeStyle = color;
    context.setLineDash(dragging ? [] : [6 / zoom, 4 / zoom]);
    context.beginPath();
    if (divider.axis === "col") {
      const x = xs[divider.index + 1] ?? 0;
      context.moveTo(x, ys[0]!);
      context.lineTo(x, ys[ys.length - 1]!);
    } else {
      const y = ys[divider.index + 1] ?? 0;
      context.moveTo(xs[0]!, y);
      context.lineTo(xs[xs.length - 1]!, y);
    }
    context.stroke();
    context.restore();
  }

  // The cell being edited. Matches `renderTextBox`, which is upstream's box
  // around the text sub-region of an element: 1/zoom, dashed, half alpha.
  if (editor?.activeCell) {
    const rect = getCellRect(
      element,
      editor.activeCell.row,
      editor.activeCell.col,
    );
    context.save();
    context.globalAlpha *= 0.5;
    context.strokeStyle = color;
    context.setLineDash([6 / zoom, 4 / zoom]);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }

  context.restore();
};

/** Re-exported so `interactiveScene` need not know the spacing constant. */
export const TABLE_CHROME_SPACING = DEFAULT_TRANSFORM_HANDLE_SPACING;
