import { LawhaModal } from "./LawhaModal";
import { plural } from "./homeText";

import type { BoardListEntry } from "../../data/boards";

interface LawhaExportModalProps {
  boards: readonly BoardListEntry[];
  busy: boolean;
  onClose: () => void;
  onExport: () => void;
}

/**
 * What is about to be written, and where it goes.
 *
 * **One `.excalidraw` bundle, and no format picker.** The mockup this page comes
 * from offered `.png` / `.svg` and "one .zip" versus "separate files"; none of
 * those exists here. There is no zip library in the tree and `package.json` is
 * frozen, and a per-board PNG would mean one browser save prompt per board. A
 * control that names a format it cannot produce is worse than no control:
 * someone picks it, presses Download, and gets a JSON file with no explanation.
 *
 * So this card states the one thing that will happen. Each board inside the
 * bundle is a complete, valid `.excalidraw` document, so a single board can be
 * lifted out with a text editor and opened anywhere.
 *
 * The partiality is named rather than hidden: a board is ciphertext plus a key
 * that only lives on the devices its share link reached, so selecting five
 * boards on a device holding three keys can only ever produce three. The report
 * that follows the export names the other two. Handing someone a backup with
 * holes they discover the day they need it is the failure this avoids.
 */
export const LawhaExportModal = ({
  boards,
  busy,
  onClose,
  onExport,
}: LawhaExportModalProps) => (
  <LawhaModal
    title={`Export ${plural(boards.length, "board")}`}
    description="Downloaded as one Lawha bundle. Any board this browser holds no key for is listed in the report afterwards rather than silently dropped."
    onClose={onClose}
  >
    <ul className="lw-export__list">
      {boards.map((board) => (
        <li key={board.id} className="lw-export__item">
          {board.name}
        </li>
      ))}
    </ul>

    <div className="lw-modal__actions">
      <button type="button" className="lw-btn" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="lw-btn lw-btn--primary"
        disabled={busy || boards.length === 0}
        onClick={onExport}
      >
        {busy ? "Exporting…" : "Download bundle"}
      </button>
    </div>
  </LawhaModal>
);
