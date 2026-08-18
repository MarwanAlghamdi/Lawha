import { useState } from "react";

import { DEFAULT_ELEMENT_BACKGROUND_PICKS } from "@excalidraw/common";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  isCodeElement,
  isTableElement,
  isTensorElement,
  parseDims,
  selectedCells,
  tableColCount,
  tableRowCount,
} from "@excalidraw/element";

import { newElementWith } from "@excalidraw/element";
import { CaptureUpdateAction } from "@excalidraw/element";

import type {
  ExcalidrawCodeElement,
  ExcalidrawTableElement,
  ExcalidrawTensorElement,
} from "@excalidraw/element/types";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { t } from "../i18n";

import { CheckboxItem } from "./CheckboxItem";

import type { AppClassProperties } from "../types";

/**
 * LAWHA: the properties panel for a table, tensor or code block.
 *
 * One component rather than three registered actions, and one line in
 * `Actions.tsx` rather than a branch per control: `packages/` is upstream, and
 * the cheapest change there is the one a merge never has to read.
 *
 * The controls answer the questions each type actually raises — a table's
 * header and its shape, a tensor's dimensions, a code block's language — and
 * nothing else. The generic stroke and background pickers above already handle
 * colour, and duplicating them here would give two controls for one property.
 */

interface LawhaElementActionsProps {
  app: AppClassProperties;
  targetElements: readonly { type: string; id: string }[];
}

export const LawhaElementActions = ({
  app,
  targetElements,
}: LawhaElementActionsProps) => {
  const element =
    targetElements.length === 1
      ? app.scene.getNonDeletedElementsMap().get(targetElements[0]!.id)
      : null;

  if (!element) {
    return null;
  }
  if (isTableElement(element)) {
    return <TableActions app={app} element={element} />;
  }
  if (isTensorElement(element)) {
    return <TensorActions app={app} element={element} />;
  }
  if (isCodeElement(element)) {
    return <CodeActions app={app} element={element} />;
  }
  return null;
};

/**
 * Commit an element change as one undo step.
 *
 * Through `syncActionResult` rather than `scene.mutateElement`, because a
 * panel click is a discrete edit and should be a discrete history entry —
 * which is what `CaptureUpdateAction.IMMEDIATELY` buys, and what a bare
 * mutation does not.
 */
const useMutate =
  (app: AppClassProperties) =>
  (element: ExcalidrawElement, updates: Record<string, unknown>) => {
    app.syncActionResult({
      elements: app.scene
        .getElementsIncludingDeleted()
        .map((el) =>
          el.id === element.id
            ? newElementWith(
                el,
                updates as Parameters<typeof newElementWith>[1],
              )
            : el,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

const TableActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawTableElement;
}) => {
  const mutate = useMutate(app);
  const editor =
    app.state.editingTableElement?.elementId === element.id
      ? app.state.editingTableElement
      : null;
  const cells = selectedCells(element, editor?.selection ?? null);
  const target =
    cells.length > 0
      ? cells
      : // With nothing bulk-selected, a fill applies to the whole grid. That
        // is the only reading of "fill" that is not a no-op, and it is
        // reversible in one undo.
        Array.from({ length: tableRowCount(element) }, (_, row) =>
          Array.from({ length: tableColCount(element) }, (_, col) => ({
            row,
            col,
          })),
        ).flat();

  const fillCells = (fill: string | null) => {
    const next = element.cells.map((row, r) =>
      row.map((cell, c) =>
        target.some((t) => t.row === r && t.col === c)
          ? { ...cell, fill }
          : cell,
      ),
    );
    mutate(element, { cells: next });
  };

  // Insert next to the bulk selection when there is one, otherwise at the end.
  const at = (axis: "row" | "col") =>
    editor?.selection?.axis === axis
      ? Math.max(...editor.selection.indices)
      : (axis === "row" ? tableRowCount(element) : tableColCount(element)) - 1;

  return (
    <fieldset>
      <legend>{t("labels.tableOptions")}</legend>

      <CheckboxItem
        checked={element.headerRow}
        onChange={(checked) => mutate(element, { headerRow: checked })}
      >
        {t("labels.tableHeaderRow")}
      </CheckboxItem>

      <div className="lawha-table-actions__label" id="lawha-cell-fill-label">
        {cells.length > 0
          ? t("labels.tableFillSelected", { count: cells.length })
          : t("labels.tableFillAll")}
      </div>
      <div
        className="lawha-table-actions__swatches"
        role="group"
        aria-labelledby="lawha-cell-fill-label"
      >
        {DEFAULT_ELEMENT_BACKGROUND_PICKS.map((color) => (
          <button
            type="button"
            key={color}
            className="lawha-table-actions__swatch"
            style={{ background: color }}
            aria-label={color === "transparent" ? t("buttons.clear") : color}
            title={color === "transparent" ? t("buttons.clear") : color}
            onClick={() => fillCells(color === "transparent" ? null : color)}
          />
        ))}
      </div>

      <div className="lawha-table-actions__label">
        {t("labels.tableGrid", {
          rows: tableRowCount(element),
          cols: tableColCount(element),
        })}
      </div>
      <div className="buttonList">
        <button
          type="button"
          className="lawha-table-actions__button"
          onClick={() => mutate(element, insertRow(element, at("row") + 1))}
        >
          {t("labels.tableAddRow")}
        </button>
        <button
          type="button"
          className="lawha-table-actions__button"
          disabled={tableRowCount(element) <= 1}
          onClick={() => mutate(element, deleteRow(element, at("row")))}
        >
          {t("labels.tableRemoveRow")}
        </button>
        <button
          type="button"
          className="lawha-table-actions__button"
          onClick={() => mutate(element, insertColumn(element, at("col") + 1))}
        >
          {t("labels.tableAddColumn")}
        </button>
        <button
          type="button"
          className="lawha-table-actions__button"
          disabled={tableColCount(element) <= 1}
          onClick={() => mutate(element, deleteColumn(element, at("col")))}
        >
          {t("labels.tableRemoveColumn")}
        </button>
      </div>
    </fieldset>
  );
};

const TensorActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawTensorElement;
}) => {
  const mutate = useMutate(app);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? element.dims.join(" × ");

  const commit = (value: string) => {
    const dims = parseDims(value);
    // An empty parse means the field is mid-edit or nonsense; keeping the
    // previous shape beats collapsing the block to nothing while you type.
    if (dims.length) {
      mutate(element, { dims });
    }
    setDraft(null);
  };

  return (
    <fieldset>
      <legend>{t("labels.tensorShape")}</legend>
      <input
        type="text"
        className="lawha-tensor-actions__input"
        value={shown}
        aria-label={t("labels.tensorShape")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit(event.currentTarget.value);
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      <div className="lawha-table-actions__label">
        {t("labels.tensorShapeHint")}
      </div>
      <input
        type="text"
        className="lawha-tensor-actions__input"
        value={element.name ?? ""}
        placeholder={t("labels.tensorName")}
        aria-label={t("labels.tensorName")}
        onChange={(event) =>
          mutate(element, { name: event.target.value || null })
        }
      />
    </fieldset>
  );
};

/**
 * The languages offered by name. highlight.js knows far more, and `auto` still
 * covers them — this list is the ones worth one click rather than a search.
 */
const CODE_LANGUAGES = [
  "auto",
  "python",
  "typescript",
  "javascript",
  "json",
  "bash",
  "sql",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "css",
  "html",
  "markdown",
  "yaml",
] as const;

const CodeActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawCodeElement;
}) => {
  const mutate = useMutate(app);

  return (
    <fieldset>
      <legend>{t("labels.codeOptions")}</legend>
      <select
        className="lawha-tensor-actions__input"
        value={element.language}
        aria-label={t("labels.codeLanguage")}
        onChange={(event) => mutate(element, { language: event.target.value })}
      >
        {CODE_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {language === "auto" ? t("labels.codeLanguageAuto") : language}
          </option>
        ))}
      </select>
      <CheckboxItem
        checked={element.showLineNumbers}
        onChange={(checked) => mutate(element, { showLineNumbers: checked })}
      >
        {t("labels.codeLineNumbers")}
      </CheckboxItem>
    </fieldset>
  );
};
