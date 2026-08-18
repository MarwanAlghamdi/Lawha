/**
 * Which grid tool is armed, and which mode the toolbar is in.
 *
 * A "tool" here is Lawha's own, not one of the editor's. Registering a real
 * `ToolType` would mean editing `packages/excalidraw/components/Tools.tsx`, its
 * two toolbars and the pointer dispatch in `App.tsx` — the most expensive file
 * in the tree to diverge (invariant 10). Instead the editor stays on the
 * selection tool and Lawha listens on `onPointerDown`, which is a public part of
 * the imperative API. The click lands, we place, the arming clears.
 */

import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { buildMatrix, identity } from "../dataviz/matrixOps";
import { buildTensor2D, buildTensor3D } from "../dataviz/tensorBuild";

import { buildCodeBlock } from "../code/codeBuild";

import { buildTable } from "./tableBuild";

export type GridMode = "standard" | "datascience";

export type GridTool = "table" | "code" | "matrix" | "tensor2d" | "tensor3d";

const MODE_KEY = "lawha-grid-mode";

/**
 * The mode is a workspace preference, so it lives in this browser rather than on
 * the account. That is a deliberate first cut: an account field would mean a
 * column, a migration and a round trip before the toolbar could render, to
 * remember something the user can re-pick in one click. If it turns out people
 * want it to follow them between machines, it moves next to `colorIndex` on the
 * profile — the shape here does not change.
 */
export const readMode = (): GridMode => {
  try {
    return window.localStorage.getItem(MODE_KEY) === "datascience"
      ? "datascience"
      : "standard";
  } catch {
    // Private mode, or storage disabled. A preference is not worth a crash.
    return "standard";
  }
};

export const writeMode = (mode: GridMode): void => {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // As above — the toolbar still works, it just forgets.
  }
};

/** Tools available in each mode. Table is general-purpose and always offered. */
export const toolsFor = (mode: GridMode): GridTool[] =>
  mode === "datascience"
    ? ["table", "code", "matrix", "tensor2d", "tensor3d"]
    : ["table", "code"];

export const TOOL_LABEL: Record<GridTool, string> = {
  table: "Table",
  code: "Code block",
  matrix: "Matrix",
  tensor2d: "Matrix block",
  tensor3d: "3D tensor",
};

export const TOOL_HINT: Record<GridTool, string> = {
  table: "Click the canvas to place a table",
  code: "Click the canvas to place a code block",
  matrix: "Click the canvas to place a matrix",
  tensor2d: "Click the canvas to place a labelled matrix block",
  tensor3d: "Click the canvas to place a 3D tensor block",
};

/**
 * Build whichever object the armed tool calls for, positioned so the click lands
 * at its centre — a tool that placed its object down-and-right of the pointer
 * would feel like it missed.
 */
export interface Placement {
  elements: ExcalidrawElement[];
  /**
   * A file the element depends on, for `excalidrawAPI.addFiles`.
   *
   * Only a code block has one: it renders to an SVG, and the image element is
   * useless without the file it points at — so the two have to be handed to the
   * editor together or the block draws as a broken-image placeholder.
   */
  file?: BinaryFileData;
}

export const placeTool = (
  tool: GridTool,
  at: { x: number; y: number },
): Placement => {
  switch (tool) {
    case "table":
      return {
        elements: buildTable({ x: at.x - 210, y: at.y - 88, rows: 4, cols: 3 }),
      };
    case "code": {
      const built = buildCodeBlock({ x: at.x - 180, y: at.y - 70 });
      return { elements: built.elements, file: built.file };
    }
    case "matrix":
      return {
        elements: buildMatrix({
          x: at.x - 84,
          y: at.y - 84,
          rows: 3,
          cols: 3,
          values: identity(3),
        }),
      };
    case "tensor2d":
      return {
        elements: buildTensor2D({
          x: at.x - 60,
          y: at.y - 60,
          dims: [512, 768],
        }),
      };
    case "tensor3d":
      return {
        elements: buildTensor3D({
          x: at.x - 70,
          y: at.y - 70,
          dims: [64, 32, 32],
        }),
      };
    default:
      return { elements: [] };
  }
};
