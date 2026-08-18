/**
 * A code block: one image element, plus the source it was rendered from.
 *
 * The rendered SVG is a *derived* artefact. The source of truth is the snippet
 * and the language choice, both carried on `customData` — which is the one field
 * `restore.ts` preserves verbatim for an element type it does not recognise, and
 * the reason a code block survives a client that has never heard of Lawha
 * (ADR 0023). Losing the picture would be a re-render; losing the source would
 * be losing the user's work.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { randomId } from "@excalidraw/common";

import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { LAWHA_KEY } from "../table/tableModel";

import { AUTO, highlight } from "./codeHighlight";
import { buildCodeSvg, svgToDataUrl } from "./codeSvg";

import type { LanguageChoice } from "./codeHighlight";

/** What a code block knows about itself, stored on the image element. */
export interface CodeTag {
  kind: "code";
  /** Shared shape with the grid tags so one reader can find every Lawha object. */
  tableId: string;
  row: 0;
  col: 0;
  source: string;
  /** The user's choice, which may be `auto`. */
  language: LanguageChoice;
  showLineNumbers: boolean;
}

export const readCodeTag = (element: ExcalidrawElement): CodeTag | null => {
  const raw = element.customData?.[LAWHA_KEY];
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tag = raw as Partial<CodeTag>;
  if (tag.kind !== "code" || typeof tag.source !== "string") {
    return null;
  }
  return {
    kind: "code",
    tableId: typeof tag.tableId === "string" ? tag.tableId : randomId(),
    row: 0,
    col: 0,
    source: tag.source,
    language: (tag.language as LanguageChoice) ?? AUTO,
    showLineNumbers: tag.showLineNumbers !== false,
  };
};

export const isCodeElement = (element: ExcalidrawElement) =>
  readCodeTag(element) !== null;

export const DEFAULT_SNIPPET = `def greet(name: str) -> str:
    # say hello, colourfully
    return f"hello, {name}"

print(greet("world"))`;

export interface RenderedCode {
  file: BinaryFileData;
  width: number;
  height: number;
  /** The language actually used, after detection. */
  language: string;
  detected: boolean;
}

/**
 * Render a snippet to a file ready for `excalidrawAPI.addFiles`.
 *
 * The file id is derived from the content rather than minted at random, so
 * re-rendering identical source reuses the file the board already has instead of
 * uploading a fresh copy on every keystroke. `generateIdFromFile` is not used
 * for this: it hashes with `crypto.subtle`, which is unavailable outside a
 * secure context (invariant 18) — and a stable id matters more here than a
 * cryptographic one, since nothing trusts this value.
 */
export const renderCode = (
  source: string,
  language: LanguageChoice,
  showLineNumbers = true,
): RenderedCode => {
  const highlighted = highlight(source, language);
  const { svg, width, height } = buildCodeSvg(highlighted, { showLineNumbers });

  return {
    file: {
      id: contentId(svg) as FileId,
      mimeType: "image/svg+xml",
      dataURL: svgToDataUrl(svg) as DataURL,
      created: Date.now(),
    },
    width,
    height,
    language: highlighted.language,
    detected: highlighted.detected,
  };
};

/**
 * A stable 40-character id for a string.
 *
 * FNV-1a over four offset seeds. Not a cryptographic hash and not trying to be —
 * it exists so identical SVGs land on the same `fileId`, and a collision would
 * mean two blocks sharing a picture rather than anything unsafe.
 */
const contentId = (value: string): string => {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(10, "0").slice(0, 10);
    })
    .join("");
};

export interface CodeBlockSpec {
  x: number;
  y: number;
  source?: string;
  language?: LanguageChoice;
  showLineNumbers?: boolean;
  codeId?: string;
}

export interface BuiltCodeBlock {
  elements: ExcalidrawElement[];
  file: BinaryFileData;
  codeId: string;
}

/** Build the image element and the file it points at. */
export const buildCodeBlock = (spec: CodeBlockSpec): BuiltCodeBlock => {
  const {
    x,
    y,
    source = DEFAULT_SNIPPET,
    language = AUTO,
    showLineNumbers = true,
    codeId = randomId(),
  } = spec;

  const rendered = renderCode(source, language, showLineNumbers);
  const tag: CodeTag = {
    kind: "code",
    tableId: codeId,
    row: 0,
    col: 0,
    source,
    language,
    showLineNumbers,
  };

  const elements = convertToExcalidrawElements([
    {
      type: "image",
      x,
      y,
      width: rendered.width,
      height: rendered.height,
      fileId: rendered.file.id,
      customData: { [LAWHA_KEY]: tag },
    },
  ] as Parameters<typeof convertToExcalidrawElements>[0]);

  return { elements, file: rendered.file, codeId };
};

/** Find a code block's image element by its id. */
export const findCodeElement = (
  elements: readonly ExcalidrawElement[],
  codeId: string,
): ExcalidrawElement | null =>
  elements.find(
    (element) => !element.isDeleted && readCodeTag(element)?.tableId === codeId,
  ) ?? null;
