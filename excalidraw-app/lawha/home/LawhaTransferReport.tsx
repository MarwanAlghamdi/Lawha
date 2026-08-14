import { plural } from "./homeText";

import type { TransferReport } from "./boardTransfer";

/**
 * What a bulk transfer actually did, in the page.
 *
 * Every outcome is named, including the ones that did not happen. A transfer
 * that reports only its successes is how a partial export becomes a backup
 * someone trusts — and an export is partial by construction here, because a
 * board is ciphertext plus a key that only lives where its share link has been
 * opened. Selecting five boards on a device that holds three keys produces
 * three, and the other two are named below rather than quietly dropped.
 *
 * An in-page panel rather than any kind of dialog: the answer is a *list*, not
 * a yes/no, and a modal that has to be dismissed before the grid can be checked
 * against it is the wrong shape for that. Native dialogs are out entirely —
 * they block the renderer, which froze this route once already.
 */
export const LawhaTransferReport = ({
  report,
  onDismiss,
}: {
  report: TransferReport;
  onDismiss: () => void;
}) => {
  const headline =
    report.kind === "export"
      ? report.filename
        ? `Exported ${plural(report.exported.length, "board")} to ${
            report.filename
          }`
        : "Nothing was exported — none of the selected boards could be decrypted here."
      : report.imported.length
      ? `Imported ${plural(report.imported.length, "board")}.`
      : "Nothing was imported.";

  const done = report.kind === "export" ? report.exported : report.imported;
  const problems = report.kind === "export" ? report.skipped : report.failed;
  const notes = report.kind === "export" ? [] : report.notes;

  return (
    <div className="lw-home__report" role="status" aria-live="polite">
      <div className="lw-home__report-head">
        <span>{headline}</span>
        <button
          type="button"
          className="lw-home__report-close"
          onClick={onDismiss}
          aria-label="Dismiss this report"
        >
          ×
        </button>
      </div>

      <ul className="lw-home__report-list">
        {done.length > 0 ? (
          <li className="lw-home__report-item">{done.join(", ")}</li>
        ) : null}

        {problems.map((problem, index) => (
          <li
            key={`${problem.label}-${index}`}
            className="lw-home__report-item lw-home__report-item--skipped"
          >
            <strong>{problem.label}</strong>
            {report.kind === "export" ? " was not exported: " : " failed: "}
            {problem.reason}
          </li>
        ))}

        {notes.map((note) => (
          <li key={note} className="lw-home__report-item">
            {note}
          </li>
        ))}
      </ul>
    </div>
  );
};
