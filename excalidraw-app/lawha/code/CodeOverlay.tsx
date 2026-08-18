import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { LAWHA_KEY } from "../table/tableModel";

import { readCodeTag, renderCode } from "./codeBuild";
import { AUTO, LANGUAGES, languageLabel } from "./codeHighlight";

import "./CodeOverlay.scss";

import type { CodeTag } from "./codeBuild";
import type { LanguageChoice } from "./codeHighlight";

interface CodeOverlayProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** Chrome, not enforcement — a viewer is offered nothing (invariant 24). */
  canEdit: boolean;
}

interface Snapshot {
  elements: readonly ExcalidrawElement[];
  viewport: {
    zoom: { value: number };
    offsetLeft: number;
    offsetTop: number;
    scrollX: number;
    scrollY: number;
  };
  selectedIds: string[];
  busy: boolean;
}

/**
 * Editing a code block.
 *
 * The block on the canvas is a picture, so it cannot be typed into directly the
 * way a cell can. The source lives on `customData` and this panel is where it is
 * edited; saving re-highlights, rebuilds the SVG and swaps the file underneath
 * the same element.
 */
export const CodeOverlay = ({ excalidrawAPI, canEdit }: CodeOverlayProps) => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [language, setLanguage] = useState<LanguageChoice>(AUTO);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const unsubscribe = excalidrawAPI.onChange((elements, appState) => {
      if (frame.current !== null) {
        return;
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setSnapshot({
          elements,
          viewport: {
            zoom: appState.zoom,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
          },
          selectedIds: Object.keys(appState.selectedElementIds ?? {}),
          busy:
            appState.selectedElementsAreBeingDragged ||
            appState.isResizing ||
            appState.isRotating,
        });
      });
    });
    return () => {
      unsubscribe();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [excalidrawAPI]);

  /** The selected code block, if exactly one is selected. */
  const selected = useMemo(() => {
    if (!snapshot || snapshot.selectedIds.length !== 1) {
      return null;
    }
    const element = snapshot.elements.find(
      (candidate) => candidate.id === snapshot.selectedIds[0],
    );
    if (!element) {
      return null;
    }
    const tag = readCodeTag(element);
    return tag ? { element, tag } : null;
  }, [snapshot]);

  /**
   * Re-render and swap the file under the element.
   *
   * The element keeps its id, so this reads to every peer as one edit rather
   * than a delete and an insert — and its own size follows the new card, since a
   * snippet that grew by three lines would otherwise be cropped by the old box.
   */
  const save = useCallback(
    (
      element: ExcalidrawElement,
      tag: CodeTag,
      source: string,
      choice: LanguageChoice,
    ) => {
      if (!excalidrawAPI) {
        return;
      }
      const rendered = renderCode(source, choice, tag.showLineNumbers);
      excalidrawAPI.addFiles([rendered.file]);

      const next: CodeTag = { ...tag, source, language: choice };
      excalidrawAPI.updateScene({
        elements: excalidrawAPI.getSceneElements().map((candidate) =>
          candidate.id === element.id
            ? ({
                ...candidate,
                fileId: rendered.file.id,
                width: rendered.width,
                height: rendered.height,
                customData: { ...candidate.customData, [LAWHA_KEY]: next },
                version: candidate.version + 1,
                versionNonce: candidate.versionNonce + 1,
                updated: Date.now(),
              } as ExcalidrawElement)
            : candidate,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [excalidrawAPI],
  );

  const toLocal = useCallback(
    (sceneX: number, sceneY: number) => {
      const viewport = snapshot!.viewport;
      const { x, y } = sceneCoordsToViewportCoords(
        { sceneX, sceneY },
        viewport as Parameters<typeof sceneCoordsToViewportCoords>[1],
      );
      return { x: x - viewport.offsetLeft, y: y - viewport.offsetTop };
    },
    [snapshot],
  );

  // Close the editor when the block it belongs to stops being selected, so a
  // panel can never be left open over a different object.
  useEffect(() => {
    if (editing && selected?.element.id !== editing) {
      setEditing(null);
    }
  }, [editing, selected]);

  if (!snapshot || !selected || !canEdit || snapshot.busy) {
    return null;
  }

  const { element, tag } = selected;
  const zoom = snapshot.viewport.zoom.value;
  const origin = toLocal(element.x, element.y);
  const isEditing = editing === element.id;

  const openEditor = () => {
    setDraft(tag.source);
    setLanguage(tag.language);
    setEditing(element.id);
  };

  return (
    <div className="lw-code" aria-label="Code block controls">
      <div
        className="lw-code__bar"
        style={{
          left: `${origin.x}px`,
          top: `${origin.y + element.height * zoom + 10}px`,
        }}
      >
        <span className="lw-code__lang" data-testid="lawha-code-language">
          {tag.language === AUTO
            ? `Auto — ${languageLabel(
                renderCode(tag.source, AUTO, tag.showLineNumbers).language,
              )}`
            : languageLabel(tag.language)}
        </span>
        <button
          type="button"
          data-testid="lawha-code-edit"
          onClick={isEditing ? () => setEditing(null) : openEditor}
        >
          {isEditing ? "Close" : "Edit code"}
        </button>
        <button
          type="button"
          data-testid="lawha-code-numbers"
          onClick={() =>
            save(
              element,
              { ...tag, showLineNumbers: !tag.showLineNumbers },
              tag.source,
              tag.language,
            )
          }
        >
          {tag.showLineNumbers ? "Hide numbers" : "Show numbers"}
        </button>
      </div>

      {isEditing ? (
        <div
          className="lw-code__editor"
          style={{
            left: `${origin.x}px`,
            top: `${origin.y + element.height * zoom + 48}px`,
          }}
        >
          <div className="lw-code__editor-head">
            <label>
              Language
              <select
                value={language}
                data-testid="lawha-code-language-select"
                onChange={(event) =>
                  setLanguage(event.target.value as LanguageChoice)
                }
              >
                <option value={AUTO}>Detect automatically</option>
                {LANGUAGES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            className="lw-code__source"
            data-testid="lawha-code-source"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            // Tab indents rather than leaving the field — in a code editor the
            // browser default is the wrong behaviour, and losing the caret
            // mid-snippet is worse than losing the tab stop.
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                const area = event.currentTarget;
                const { selectionStart: from, selectionEnd: to } = area;
                const next = `${draft.slice(0, from)}  ${draft.slice(to)}`;
                setDraft(next);
                requestAnimationFrame(() => {
                  area.selectionStart = area.selectionEnd = from + 2;
                });
              }
            }}
          />
          <div className="lw-code__editor-foot">
            <button
              type="button"
              className="lw-code__save"
              data-testid="lawha-code-save"
              onClick={() => {
                save(element, tag, draft, language);
                setEditing(null);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
