import { useState } from "react";

import { DEFAULT_ELEMENT_BACKGROUND_PICKS } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  deleteColumn,
  deleteRow,
  isCodeElement,
  isTableElement,
  isTensorElement,
  languageLabel,
  LANGUAGES,
  newElementWith,
  parseDims,
  selectedCells,
  tableColCount,
  tableRowCount,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  ExcalidrawCodeElement,
  ExcalidrawTableElement,
  ExcalidrawTensorElement,
} from "@excalidraw/element/types";

import { t } from "../i18n";

import { TopPicks } from "./ColorPicker/TopPicks";
import {
  CodeLineNumbersOffIcon,
  CodeLineNumbersOnIcon,
  MatrixBracketsOffIcon,
  MatrixBracketsOnIcon,
  MatrixHeatmapIcon,
  MatrixIndicesIcon,
  TableDeleteColumnIcon,
  TableDeleteRowIcon,
  TableHeaderOffIcon,
  TableHeaderOnIcon,
} from "./icons";
import { RadioSelection } from "./RadioSelection";

import type { JSX } from "react";

import type { AppClassProperties } from "../types";

/**
 * LAWHA: the properties panel for a table, matrix, tensor or code block.
 *
 * One component and one line in `Actions.tsx` rather than a registered action
 * per control: `packages/` is upstream, and the cheapest change there is the
 * one a merge never has to read.
 *
 * Every control here is an existing Excalidraw primitive. The previous version
 * hand-rolled all of them and got the design-system equivalent of a foreign
 * accent — a 44px blue `CheckboxItem` built for export dialogs, a 2x2 grid of
 * text pills in a container that forces 2rem icon squares, swatches without
 * `--theme-filter` so they stopped matching the Background row above them in
 * dark mode, and a native OS `<select>`. Booleans are two-option
 * `RadioSelection`s, the way `changeRoundness` does it, because the design
 * system has no in-panel checkbox that is not off-brand blue.
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
 * Through `syncActionResult` rather than a bare mutation, because a panel
 * click is a discrete edit and should be a discrete history entry. Not named
 * `use*`: it calls no hooks, and `react-hooks/rules-of-hooks` polices anything
 * that looks like one.
 */
const makeMutator =
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

/** A two-option boolean row, the shape `changeRoundness` uses. */
const BooleanRow = <T extends boolean>({
  legend,
  value,
  onChange,
  offIcon,
  onIcon,
  offText,
  onText,
  testIdPrefix,
}: {
  legend: string;
  value: boolean;
  onChange: (next: boolean) => void;
  offIcon: JSX.Element;
  onIcon: JSX.Element;
  offText: string;
  onText: string;
  testIdPrefix: string;
}) => (
  <fieldset>
    <legend>{legend}</legend>
    <div className="buttonList">
      <RadioSelection<T>
        group={testIdPrefix}
        options={[
          {
            value: false as T,
            text: offText,
            icon: offIcon,
            testId: `${testIdPrefix}-off`,
          },
          {
            value: true as T,
            text: onText,
            icon: onIcon,
            testId: `${testIdPrefix}-on`,
          },
        ]}
        value={value as T}
        onChange={(next) => onChange(Boolean(next))}
      />
    </div>
  </fieldset>
);

const TableActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawTableElement;
}) => {
  const mutate = makeMutator(app);
  const isMatrix = element.variant === "matrix";
  const editor =
    app.state.editingTableElement?.elementId === element.id
      ? app.state.editingTableElement
      : null;
  const selection = editor?.selection ?? null;
  const cells = selectedCells(element, selection);

  // With nothing bulk-selected a fill applies to the whole grid: that is the
  // only reading of "fill" that is not a no-op, and it is one undo away.
  const target =
    cells.length > 0
      ? cells
      : Array.from({ length: tableRowCount(element) }, (_, row) =>
          Array.from({ length: tableColCount(element) }, (_, col) => ({
            row,
            col,
          })),
        ).flat();

  const fillCells = (fill: string) => {
    const next = element.cells.map((row, r) =>
      row.map((cell, c) =>
        target.some((t) => t.row === r && t.col === c)
          ? { ...cell, fill: fill === "transparent" ? null : fill }
          : cell,
      ),
    );
    mutate(element, { cells: next });
  };

  // Remove acts on the bulk selection when there is one, otherwise the last.
  const at = (axis: "row" | "col") =>
    selection?.axis === axis
      ? Math.min(
          Math.max(...selection.indices),
          (axis === "row" ? tableRowCount(element) : tableColCount(element)) -
            1,
        )
      : (axis === "row" ? tableRowCount(element) : tableColCount(element)) - 1;

  const commonFill =
    target.length > 0
      ? target.reduce<string | null | undefined>((acc, { row, col }) => {
          const fill = element.cells[row]?.[col]?.fill ?? "transparent";
          return acc === undefined || acc === fill ? fill : null;
        }, undefined) ?? null
      : null;

  return (
    <>
      <fieldset>
        <legend>
          {isMatrix ? t("labels.matrixOptions") : t("labels.tableOptions")}
        </legend>
        <div className="buttonList">
          <RadioSelection<"deleteRow" | "deleteCol">
            type="button"
            options={[
              {
                value: "deleteRow",
                text: t("labels.tableRemoveRow"),
                icon: TableDeleteRowIcon,
                testId: "lawha-table-remove-row",
                active: false,
              },
              {
                value: "deleteCol",
                text: t("labels.tableRemoveColumn"),
                icon: TableDeleteColumnIcon,
                testId: "lawha-table-remove-column",
                active: false,
              },
            ]}
            value={null}
            onClick={(value) =>
              mutate(
                element,
                value === "deleteRow"
                  ? deleteRow(element, at("row"))
                  : deleteColumn(element, at("col")),
              )
            }
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>
          {cells.length > 0
            ? t("labels.tableFillSelected")
            : t("labels.tableFillAll")}
        </legend>
        <TopPicks
          type="elementBackground"
          activeColor={
            commonFill === "transparent" ? "transparent" : commonFill
          }
          onChange={fillCells}
          topPicks={DEFAULT_ELEMENT_BACKGROUND_PICKS}
        />
      </fieldset>

      {!isMatrix && (
        <BooleanRow
          legend={t("labels.tableHeaderRow")}
          value={element.headerRow}
          onChange={(headerRow) => mutate(element, { headerRow })}
          offIcon={TableHeaderOffIcon}
          onIcon={TableHeaderOnIcon}
          offText={t("labels.tableHeaderRowOff")}
          onText={t("labels.tableHeaderRowOn")}
          testIdPrefix="lawha-header-row"
        />
      )}

      {isMatrix && (
        <>
          <BooleanRow
            legend={t("labels.matrixBrackets")}
            value={element.brackets}
            onChange={(brackets) => mutate(element, { brackets })}
            offIcon={MatrixBracketsOffIcon}
            onIcon={MatrixBracketsOnIcon}
            offText={t("labels.matrixBracketsOff")}
            onText={t("labels.matrixBracketsOn")}
            testIdPrefix="lawha-brackets"
          />
          <fieldset>
            <legend>{t("labels.matrixReadout")}</legend>
            <div className="buttonList">
              <RadioSelection<"indices" | "heatmap">
                type="button"
                options={[
                  {
                    value: "indices",
                    text: t("labels.matrixIndices"),
                    icon: MatrixIndicesIcon,
                    testId: "lawha-indices",
                    active: element.showIndices,
                  },
                  {
                    value: "heatmap",
                    text: t("labels.matrixHeatmap"),
                    icon: MatrixHeatmapIcon,
                    testId: "lawha-heatmap",
                    active: element.heatmap,
                  },
                ]}
                value={null}
                onClick={(value) =>
                  mutate(
                    element,
                    value === "indices"
                      ? { showIndices: !element.showIndices }
                      : { heatmap: !element.heatmap },
                  )
                }
              />
            </div>
          </fieldset>
        </>
      )}
    </>
  );
};

/**
 * A panel-scale text input.
 *
 * The design system has none — `TextField` is dialog-scale at 3rem. Built to
 * the height of a panel button so a row of these sits level with the icon
 * rows, and styled through a class rather than inline so it themes.
 */
const PanelInput = ({
  value,
  onChange,
  onCommit,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
  placeholder?: string;
  label: string;
  testId: string;
}) => (
  <input
    type="text"
    className="lawha-panel-input"
    value={value}
    aria-label={label}
    placeholder={placeholder}
    data-testid={testId}
    onChange={(event) => onChange(event.target.value)}
    onBlur={(event) => onCommit(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        onCommit(event.currentTarget.value);
        event.currentTarget.blur();
      }
      if (event.key === "Escape") {
        event.currentTarget.blur();
      }
    }}
    autoComplete="off"
    spellCheck={false}
  />
);

const TensorActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawTensorElement;
}) => {
  const mutate = makeMutator(app);
  const [shapeDraft, setShapeDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  return (
    <fieldset>
      <legend>{t("labels.tensorShape")}</legend>
      <PanelInput
        value={shapeDraft ?? element.dims.join(" × ")}
        label={t("labels.tensorShape")}
        testId="lawha-tensor-shape"
        onChange={setShapeDraft}
        onCommit={(next) => {
          const dims = parseDims(next);
          // An unparseable draft keeps the previous shape rather than
          // collapsing the block to nothing while you are mid-edit.
          if (dims.length) {
            mutate(element, { dims });
          }
          setShapeDraft(null);
        }}
      />
      <PanelInput
        value={nameDraft ?? element.name ?? ""}
        placeholder={t("labels.tensorName")}
        label={t("labels.tensorName")}
        testId="lawha-tensor-name"
        // Held as a draft and committed on blur: writing through on every
        // keystroke put one undo entry in the history per character.
        onChange={setNameDraft}
        onCommit={(next) => {
          mutate(element, { name: next || null });
          setNameDraft(null);
        }}
      />
    </fieldset>
  );
};

const CodeActions = ({
  app,
  element,
}: {
  app: AppClassProperties;
  element: ExcalidrawCodeElement;
}) => {
  const mutate = makeMutator(app);

  return (
    <>
      <fieldset>
        <legend>{t("labels.codeLanguage")}</legend>
        <select
          className="dropdown-select"
          value={element.language}
          aria-label={t("labels.codeLanguage")}
          data-testid="lawha-code-language"
          onChange={(event) =>
            mutate(element, { language: event.target.value })
          }
        >
          <option value="auto">{t("labels.codeLanguageAuto")}</option>
          {LANGUAGES.map((language) => (
            <option key={language.id} value={language.id}>
              {languageLabel(language.id)}
            </option>
          ))}
        </select>
      </fieldset>
      <BooleanRow
        legend={t("labels.codeLineNumbers")}
        value={element.showLineNumbers}
        onChange={(showLineNumbers) => mutate(element, { showLineNumbers })}
        offIcon={CodeLineNumbersOffIcon}
        onIcon={CodeLineNumbersOnIcon}
        offText={t("labels.codeLineNumbersOff")}
        onText={t("labels.codeLineNumbersOn")}
        testIdPrefix="lawha-line-numbers"
      />
    </>
  );
};
