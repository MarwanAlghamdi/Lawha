import { useState } from "react";

import {
  DEFAULT_ELEMENT_BACKGROUND_PICKS,
  DEFAULT_ELEMENT_STROKE_PICKS,
} from "@excalidraw/common";
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
  TableCell,
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
  TextAlignBottomIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignMiddleIcon,
  TextAlignRightIcon,
  TextAlignTopIcon,
  TextBoldIcon,
  TextItalicIcon,
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

  /**
   * Paint the current selection — a cell, a row, a column, or the whole grid
   * when nothing is picked out. `transparent` clears rather than paints, which
   * is the only reading of a transparent swatch that is not a no-op.
   */
  const paintCells = (key: "fill" | "color", value: string) => {
    const next = element.cells.map((row, r) =>
      row.map((cell, c) =>
        target.some((t) => t.row === r && t.col === c)
          ? { ...cell, [key]: value === "transparent" ? null : value }
          : cell,
      ),
    );
    mutate(element, { cells: next });
  };

  /** The selection's common value for a cell key, or null when mixed. */
  const commonOf = (key: "fill" | "color") =>
    target.reduce<string | null | undefined>((acc, { row, col }) => {
      const v = element.cells[row]?.[col]?.[key] ?? "transparent";
      return acc === undefined || acc === v ? v : null;
    }, undefined) ?? null;

  // ADR 0027. Text properties resolve per cell and fall back to the element,
  // so the panel has to show the RESOLVED value — a header cell reads as bold
  // whether or not anything was ever written to it.
  const resolvedAlign = (row: number, col: number) =>
    element.cells[row]?.[col]?.align ?? element.textAlign;
  const resolvedVerticalAlign = (row: number, col: number) =>
    element.cells[row]?.[col]?.verticalAlign ?? element.verticalAlign ?? "top";
  const resolvedBold = (row: number, col: number) =>
    element.cells[row]?.[col]?.bold ?? (element.headerRow && row === 0);
  const resolvedItalic = (row: number, col: number) =>
    element.cells[row]?.[col]?.italic ?? false;

  /** The selection's common resolved value, or null when it is mixed. */
  const commonBy = <T,>(read: (row: number, col: number) => T): T | null =>
    target.reduce<T | null | undefined>((acc, { row, col }) => {
      const v = read(row, col);
      return acc === undefined || acc === v ? v : null;
    }, undefined) ?? null;

  const paintText = (patch: Partial<TableCell>) =>
    mutate(element, {
      cells: element.cells.map((row, r) =>
        row.map((cell, c) =>
          target.some((sel) => sel.row === r && sel.col === c)
            ? { ...cell, ...patch }
            : cell,
        ),
      ),
    });

  /**
   * Horizontal alignment.
   *
   * With a bulk selection this writes to those cells. With nothing selected it
   * moves the ELEMENT's default and clears the per-cell overrides that would
   * otherwise mask it — so "click the table, press centre" still centres the
   * whole grid, which is the behaviour 0026 wanted. Making it per-cell takes
   * selecting a cell first, which is the deliberate act 0026 was worried was
   * missing.
   */
  const setHorizontal = (textAlign: ExcalidrawTableElement["textAlign"]) =>
    cells.length > 0
      ? paintText({ align: textAlign })
      : mutate(element, {
          textAlign,
          cells: element.cells.map((row) =>
            row.map((cell) => ({ ...cell, align: null })),
          ),
        });

  const setVertical = (
    verticalAlign: ExcalidrawTableElement["verticalAlign"],
  ) =>
    cells.length > 0
      ? paintText({ verticalAlign })
      : mutate(element, {
          verticalAlign,
          cells: element.cells.map((row) =>
            row.map((cell) => ({ ...cell, verticalAlign: null })),
          ),
        });

  // Remove acts on the bulk selection when there is one, otherwise the last.
  const at = (axis: "row" | "col") =>
    selection?.axis === axis
      ? Math.min(
          Math.max(...selection.indices),
          (axis === "row" ? tableRowCount(element) : tableColCount(element)) -
            1,
        )
      : (axis === "row" ? tableRowCount(element) : tableColCount(element)) - 1;

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
            ? t("labels.tableAlignSelected")
            : t("labels.tableAlign")}
        </legend>
        <div className="buttonList">
          <RadioSelection<ExcalidrawTableElement["textAlign"]>
            group="lawha-text-align"
            options={[
              {
                value: "left",
                text: t("labels.left"),
                icon: TextAlignLeftIcon,
                testId: "lawha-align-left",
              },
              {
                value: "center",
                text: t("labels.center"),
                icon: TextAlignCenterIcon,
                testId: "lawha-align-center",
              },
              {
                value: "right",
                text: t("labels.right"),
                icon: TextAlignRightIcon,
                testId: "lawha-align-right",
              },
            ]}
            value={
              cells.length > 0 ? commonBy(resolvedAlign) : element.textAlign
            }
            onChange={setHorizontal}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>{t("labels.tableVerticalAlign")}</legend>
        <div className="buttonList">
          <RadioSelection<ExcalidrawTableElement["verticalAlign"]>
            group="lawha-vertical-align"
            options={[
              {
                value: "top",
                text: t("labels.alignTop"),
                icon: <TextAlignTopIcon theme={app.state.theme} />,
                testId: "lawha-valign-top",
              },
              {
                value: "middle",
                text: t("labels.centerVertically"),
                icon: <TextAlignMiddleIcon theme={app.state.theme} />,
                testId: "lawha-valign-middle",
              },
              {
                value: "bottom",
                text: t("labels.alignBottom"),
                icon: <TextAlignBottomIcon theme={app.state.theme} />,
                testId: "lawha-valign-bottom",
              },
            ]}
            value={
              cells.length > 0
                ? commonBy(resolvedVerticalAlign)
                : element.verticalAlign ?? "top"
            }
            onChange={setVertical}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>{t("labels.tableTextStyle")}</legend>
        <div className="buttonList">
          <RadioSelection<"bold" | "italic">
            type="button"
            options={[
              {
                value: "bold",
                text: t("labels.bold"),
                icon: TextBoldIcon,
                testId: "lawha-cell-bold",
                active: commonBy(resolvedBold) === true,
              },
              {
                value: "italic",
                text: t("labels.italic"),
                icon: TextItalicIcon,
                testId: "lawha-cell-italic",
                active: commonBy(resolvedItalic) === true,
              },
            ]}
            value={null}
            onClick={(which) =>
              // Always an explicit boolean, never back to null: a toggle whose
              // off state means "inherit" reads as broken on a header row,
              // where inheriting is on.
              which === "bold"
                ? paintText({ bold: commonBy(resolvedBold) !== true })
                : paintText({ italic: commonBy(resolvedItalic) !== true })
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
          activeColor={commonOf("fill")}
          onChange={(fill) => paintCells("fill", fill)}
          topPicks={DEFAULT_ELEMENT_BACKGROUND_PICKS}
        />
      </fieldset>

      <fieldset>
        <legend>{t("labels.tableTextColor")}</legend>
        <TopPicks
          type="elementStroke"
          activeColor={commonOf("color")}
          onChange={(color) => paintCells("color", color)}
          topPicks={DEFAULT_ELEMENT_STROKE_PICKS}
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
