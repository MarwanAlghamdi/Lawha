import {
  ANCHOR_PX,
  columnOffsets,
  getCellRect,
  getElementAbsoluteCoords,
  rowOffsets,
  tableColCount,
  tableRowCount,
} from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawTableElement,
} from "@excalidraw/element/types";

import type { InteractiveCanvasAppState } from "../types";
import type { InteractiveCanvasRenderConfig } from "../scene/types";

/**
 * LAWHA: the interior chrome of a table — row/column anchors, the divider
 * being dragged, the bulk selection, and the active cell.
 *
 * Kept out of `interactiveScene.ts` so that file gains an import and one call
 * rather than a hundred lines: `packages/` is upstream, and the cheapest
 * change there is the one a merge never has to look at.
 *
 * Everything is drawn in Excalidraw's own visual language — `selectionColor`,
 * `1 / zoom` strokes, white-filled handles — because canvas chrome that
 * invents its own aesthetic reads as a bug rather than as a feature.
 */

/** Gap between the table's edge and its anchor strip, in screen pixels. */
const ANCHOR_GAP_PX = 2;

/** Alpha for an idle anchor. Selected anchors are drawn fully opaque. */
const ANCHOR_IDLE_ALPHA = 0.22;

/** Alpha for the wash over a bulk-selected row or column. */
const BULK_FILL_ALPHA = 0.12;

export const renderTableHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  element: ExcalidrawTableElement,
  elementsMap: ElementsMap,
): void => {
  const editor = appState.editingTableElement;
  const zoom = appState.zoom.value;
  const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);

  const strip = ANCHOR_PX / zoom;
  const gap = ANCHOR_GAP_PX / zoom;
  const radius = 2 / zoom;
  const color = renderConfig.selectionColor;

  const xs = columnOffsets(element);
  const ys = rowOffsets(element);
  const cols = tableColCount(element);
  const rows = tableRowCount(element);

  const selection = editor?.elementId === element.id ? editor.selection : null;
  const isSelected = (axis: "col" | "row", index: number) =>
    selection?.axis === axis && selection.indices.includes(index);

  context.save();
  // Draw in the element's own unrotated frame, so a rotated table keeps its
  // anchors welded to its edges instead of floating beside them.
  context.translate(cx, cy);
  context.rotate(element.angle);
  context.translate(-cx, -cy);
  context.translate(element.x, element.y);

  context.lineWidth = 1 / zoom;

  // The wash over a bulk selection, drawn first so the grid lines stay legible
  // through it.
  if (selection) {
    context.globalAlpha = BULK_FILL_ALPHA;
    context.fillStyle = color;
    for (const index of selection.indices) {
      if (selection.axis === "col" && index < cols) {
        context.fillRect(
          xs[index]!,
          0,
          xs[index + 1]! - xs[index]!,
          element.height,
        );
      } else if (selection.axis === "row" && index < rows) {
        context.fillRect(
          0,
          ys[index]!,
          element.width,
          ys[index + 1]! - ys[index]!,
        );
      }
    }
    context.globalAlpha = 1;
  }

  // Column anchors, above the table; row anchors, to its left. Both sit where
  // a reader already looks for them, and off the cells they address.
  const drawAnchor = (
    x: number,
    y: number,
    width: number,
    height: number,
    selected: boolean,
  ) => {
    context.globalAlpha = selected ? 1 : ANCHOR_IDLE_ALPHA;
    context.fillStyle = color;
    context.strokeStyle = "transparent";
    roundRectPath(context, x, y, width, height, radius);
    context.fill();
    context.globalAlpha = 1;
  };

  for (let i = 0; i < cols; i++) {
    const width = xs[i + 1]! - xs[i]! - gap;
    if (width > 0) {
      drawAnchor(xs[i]!, -gap - strip, width, strip, isSelected("col", i));
    }
  }
  for (let i = 0; i < rows; i++) {
    const height = ys[i + 1]! - ys[i]! - gap;
    if (height > 0) {
      drawAnchor(-gap - strip, ys[i]!, strip, height, isSelected("row", i));
    }
  }

  // The divider under the cursor, or the one being dragged. Only ever one, and
  // only while it is relevant — a table permanently outlined in accent colour
  // is noise.
  const divider =
    editor?.elementId === element.id
      ? editor.draggingDivider ?? editor.hoveredDivider
      : null;

  if (divider) {
    context.strokeStyle = color;
    context.lineWidth = 2 / zoom;
    context.beginPath();
    if (divider.axis === "col") {
      const x = xs[divider.index + 1] ?? 0;
      context.moveTo(x, -gap - strip);
      context.lineTo(x, element.height);
    } else {
      const y = ys[divider.index + 1] ?? 0;
      context.moveTo(-gap - strip, y);
      context.lineTo(element.width, y);
    }
    context.stroke();
    context.lineWidth = 1 / zoom;
  }

  // The cell being edited.
  if (editor?.elementId === element.id && editor.activeCell) {
    const rect = getCellRect(
      element,
      editor.activeCell.row,
      editor.activeCell.col,
    );
    context.strokeStyle = color;
    context.lineWidth = 1.5 / zoom;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  context.restore();
};

/** `roundRect` without the implicit fill/stroke, so callers control paint. */
const roundRectPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
};
