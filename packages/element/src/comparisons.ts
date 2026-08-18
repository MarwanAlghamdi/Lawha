import type { ElementOrToolType } from "@excalidraw/excalidraw/types";

export const hasBackground = (type: ElementOrToolType) =>
  type === "rectangle" ||
  // LAWHA: a table's background is the fill behind cells that set none of
  // their own; a tensor's is the colour its three faces are shaded from.
  type === "table" ||
  type === "tensor" ||
  type === "iframe" ||
  type === "embeddable" ||
  type === "ellipse" ||
  type === "diamond" ||
  type === "line" ||
  type === "freedraw" ||
  type === "autoshape";

export const hasStrokeColor = (type: ElementOrToolType) =>
  type === "rectangle" ||
  type === "table" ||
  type === "tensor" ||
  type === "ellipse" ||
  type === "diamond" ||
  type === "freedraw" ||
  type === "arrow" ||
  type === "line" ||
  type === "text" ||
  type === "embeddable" ||
  type === "autoshape";

export const hasStrokeWidth = (type: ElementOrToolType) =>
  type === "rectangle" ||
  type === "table" ||
  type === "tensor" ||
  type === "iframe" ||
  type === "embeddable" ||
  type === "ellipse" ||
  type === "diamond" ||
  type === "freedraw" ||
  type === "arrow" ||
  type === "line" ||
  type === "autoshape";

export const hasStrokeStyle = (type: ElementOrToolType) =>
  type === "rectangle" ||
  type === "table" ||
  type === "tensor" ||
  type === "iframe" ||
  type === "embeddable" ||
  type === "ellipse" ||
  type === "diamond" ||
  type === "arrow" ||
  type === "line" ||
  type === "autoshape";

export const hasFreedrawMode = (type: ElementOrToolType) => type === "freedraw";

export const canChangeRoundness = (type: ElementOrToolType) =>
  type === "rectangle" ||
  type === "iframe" ||
  type === "embeddable" ||
  type === "line" ||
  type === "diamond" ||
  type === "image";

export const toolIsArrow = (type: ElementOrToolType) => type === "arrow";

export const canHaveArrowheads = (type: ElementOrToolType) => type === "arrow";
