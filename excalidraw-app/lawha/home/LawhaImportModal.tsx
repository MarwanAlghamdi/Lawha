import { useRef, useState } from "react";

import { NO_FOLDER } from "./boardFilters";
import { LawhaModal } from "./LawhaModal";

import type { FolderOption } from "./LawhaSelectionBar";

interface LawhaImportModalProps {
  folderOptions: FolderOption[];
  /** Pre-selected to the folder currently open, so the obvious answer is default. */
  defaultFolderId: string | null;
  busy: boolean;
  onClose: () => void;
  onImport: (files: File[], folderId: string | null) => void;
}

/** Kilobytes, because a board file is never megabytes and "0.1 MB" reads badly. */
const sizeOf = (file: File) =>
  `${Math.max(1, Math.round(file.size / 1024))} KB`;

/**
 * Import boards from files.
 *
 * A drop zone rather than only a file picker, because the natural gesture for
 * "I have twelve .excalidraw files" is to drag them in, and because the picker
 * on its own gives no chance to say *where* they should land — which was the
 * gap: every import went to the unfiled pile and then had to be tidied by hand.
 *
 * The list of pending files is shown and is removable before anything is
 * written. An import mints a new board and a new key per file; there is no
 * undo, so the last chance to notice you picked the wrong folder is here.
 */
export const LawhaImportModal = ({
  folderOptions,
  defaultFolderId,
  busy,
  onClose,
  onImport,
}: LawhaImportModalProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [hovering, setHovering] = useState(false);
  const [folderId, setFolderId] = useState<string>(
    defaultFolderId ?? NO_FOLDER,
  );

  const add = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setPending((current) => [...current, ...Array.from(files)]);
  };

  return (
    <LawhaModal
      title="Import boards"
      description="Drop several .excalidraw or .excalidrawlib files at once. Each becomes its own board, with a new key minted in this browser."
      onClose={onClose}
      wide
    >
      {/*
        A button, so the keyboard gets in: a div with onClick is a drop zone
        nobody can reach with Tab. The drag handlers sit on the same element —
        `onDragOver` calling `preventDefault` is what makes it a drop target at
        all, and without it `onDrop` never fires and nothing anywhere says why.
      */}
      <button
        type="button"
        className={`lw-drop-zone${hovering ? " lw-drop-zone--over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setHovering(true);
        }}
        onDragLeave={() => setHovering(false)}
        onDrop={(event) => {
          event.preventDefault();
          setHovering(false);
          add(event.dataTransfer?.files ?? null);
        }}
      >
        <span className="lw-drop-zone__title">
          {hovering
            ? "Release to add them"
            : "Drop files here, or click to browse"}
        </span>
        <span className="lw-drop-zone__hint">
          .excalidraw · .excalidrawlib · .json
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        // Deliberately permissive: iOS will not offer `.excalidraw` files from
        // a filtered picker at all.
        accept=".excalidraw,.excalidrawlib,.json,application/json"
        hidden
        onChange={(event) => {
          add(event.target.files);
          // So picking the same file twice in a row still fires a change.
          event.target.value = "";
        }}
      />

      {pending.length ? (
        <ul className="lw-import__list">
          {pending.map((file, index) => (
            <li key={`${file.name}-${index}`} className="lw-import__item">
              <span className="lw-import__name">{file.name}</span>
              <span className="lw-import__size">{sizeOf(file)}</span>
              <button
                type="button"
                className="lw-import__remove"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setPending((current) =>
                    current.filter((_, other) => other !== index),
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="lw-field">
        <label className="lw-field__label" htmlFor="lw-import-folder">
          Import into
        </label>
        <select
          id="lw-import-folder"
          className="lw-select"
          value={folderId}
          onChange={(event) => setFolderId(event.target.value)}
        >
          <option value={NO_FOLDER}>No folder</option>
          {folderOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="lw-modal__actions">
        <button type="button" className="lw-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="lw-btn lw-btn--primary"
          disabled={busy || pending.length === 0}
          onClick={() =>
            onImport(pending, folderId === NO_FOLDER ? null : folderId)
          }
        >
          {busy
            ? "Importing…"
            : `Import ${pending.length || ""} ${
                pending.length === 1 ? "file" : "files"
              }`.trim()}
        </button>
      </div>
    </LawhaModal>
  );
};
