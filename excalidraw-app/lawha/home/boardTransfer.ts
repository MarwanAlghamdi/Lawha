import { MIME_TYPES } from "@excalidraw/common";
import { isInitializedImageElement } from "@excalidraw/element";
import { getSceneVersion } from "@excalidraw/element";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { fileOpen, fileSave } from "@excalidraw/excalidraw/data/filesystem";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  FILE_STORAGE_PREFIXES,
  FILE_UPLOAD_MAX_BYTES,
} from "../../app_constants";
import { generateBoardId, getSyncableElements } from "../../data";
import { encodeFilesForUpload } from "../../data/FileManager";
import { resolveBoardKey } from "../../data/boardKeys";
import { createBoard } from "../../data/boards";
import {
  loadFilesFromBackend,
  loadFromBackend,
  saveFilesToBackend,
} from "../../data/storage";

import type { BoardListEntry } from "../../data/boards";

/**
 * Bulk export and import for the dashboard.
 *
 * **Export used to be partial by design.** A board was ciphertext under a key
 * the server had never held, so exporting one meant decrypting it, which only
 * a device holding that key could do — every other board was skipped and named
 * in the report. Scenes are plaintext since ADR 0012, so the ordinary case is
 * now that everything exports. A board still stored encrypted, on a browser
 * that cannot obtain its key, remains the one thing that can be skipped, and it
 * is still named rather than dropped.
 *
 * **Import mints a new board per file**, rather than adopting the elements into
 * an existing board: there is no id in a `.excalidraw` file, and overwriting a
 * board you already have would be a data-loss bug wearing an import button.
 */

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/**
 * One JSON file for the whole dashboard rather than a zip of `.excalidraw`
 * files: a zip needs a zip library, `package.json` is frozen, and hand-rolling
 * DEFLATE for a backup format is not a trade anyone should take. Each board's
 * `scene` is nevertheless a *complete, valid* `.excalidraw` document, so a
 * single board can be lifted out of the bundle with a text editor and opened
 * anywhere.
 */
export const BUNDLE_TYPE = "lawha/boards";
export const BUNDLE_VERSION = 1;

export interface BundledBoard {
  id: string;
  name: string;
  linkAccess: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Recorded, not restored. Tags are per-person rows on the server (a copy of
   * "design" is yours alone), so re-creating them on import would invent rows
   * whose only justification is a string in a file. Keeping the names here
   * means the information is not lost; reattaching them is a dashboard action.
   */
  tagNames: string[];
  /** A whole `.excalidraw` document, as `serializeAsJSON(…, "local")` writes it. */
  scene: unknown;
}

export interface LawhaBoardBundle {
  type: typeof BUNDLE_TYPE;
  version: number;
  exportedAt: number;
  boards: BundledBoard[];
}

/** A board that did not make it, with the reason stated rather than swallowed. */
export interface TransferSkip {
  label: string;
  reason: string;
}

export interface ExportReport {
  kind: "export";
  /** null when nothing could be decrypted, so no file was written. */
  filename: string | null;
  exported: string[];
  skipped: TransferSkip[];
}

export interface ImportReport {
  kind: "import";
  imported: string[];
  /**
   * The board ids just created, in the same order as `imported`.
   *
   * Needed because the import modal asks which folder to import *into*, and
   * filing is a second call per board. Matching the names back up against a
   * reloaded list would file the wrong board the moment two imports share a
   * name — which, importing the same bundle twice, is the normal case.
   */
  importedIds: string[];
  failed: TransferSkip[];
  /** Non-fatal outcomes worth stating: dropped tags, unuploadable images. */
  notes: string[];
}

export type TransferReport = ExportReport | ImportReport;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const reasonOf = (caught: unknown): string =>
  caught instanceof Error && caught.message
    ? caught.message
    : "it could not be read";

/** Local calendar day, not UTC: the filename should match the user's date. */
const isoDay = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
};

const stripExtension = (filename: string): string =>
  filename.replace(/\.[^./\\]+$/, "").trim();

/**
 * `Blob.prototype.text` is missing in jsdom and in older Safari, and the app
 * has to read a bundle before it knows whether it is one. The FileReader path
 * is what the package's own `parseFileContents` falls back to.
 */
const readAsText = async (blob: Blob): Promise<string> => {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsText(blob, "utf8");
  });
};

/**
 * What is degraded, rather than what is forbidden. See ADR 0018.
 *
 * This used to throw, and refusing outright was right while invariant 18 was
 * whole: every board key was minted with `window.crypto.subtle`, so without it
 * the app was inert rather than degraded. ADR 0012 removed the keys, and this
 * deployment now runs on a plain-http name behind a gateway, where browsers
 * withhold `crypto.subtle` entirely. Keeping the throw would have made import
 * and export unreachable for a deployment where both very nearly work.
 *
 * What actually breaks without it, precisely:
 *
 *   - Image ids are a SHA-1 of the bytes. `generateIdFromFile` catches the
 *     missing API itself and falls back to a random 40-char id, so uploads
 *     succeed and the SAME image imported twice is stored twice. Wasteful,
 *     not broken — and worth saying out loud, which is what this returns.
 *
 *   - A board stored before ADR 0012 cannot be decrypted. That is NOT handled
 *     here, deliberately: the export loop already resolves a key per board and
 *     catches the failure into `skipped` with a reason, which reports the one
 *     board that is affected instead of refusing all of them. A fresh database
 *     has none at all.
 *
 * Returns a sentence for the report, or null when the browser has the API.
 * Never throws — a note belongs in the result, not in a stack trace.
 */
export const secureContextNote = (): string | null =>
  window.isSecureContext && window.crypto?.subtle
    ? null
    : "This deployment is served over plain http, so the browser withholds " +
      "window.crypto.subtle. Imported images get random ids instead of a hash " +
      "of their contents, which means the same image imported twice is stored " +
      "twice. Nothing is lost.";

/** browser-fs-access rejects with an AbortError when the picker is dismissed. */
export const isCancellation = (caught: unknown): boolean =>
  (caught as { name?: string } | null)?.name === "AbortError";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The images a board references, pulled back out of the file store.
 *
 * Without this an exported board opens with every image a broken placeholder:
 * elements carry a `fileId`, not the bytes.
 *
 * `boardKey` is nullable and is only consulted for a file uploaded before ADR
 * 0012 — the reader picks its path from the container's own header.
 */
const collectFiles = async (
  boardId: string,
  boardKey: string | null,
  elements: readonly ExcalidrawElement[],
): Promise<BinaryFiles> => {
  const fileIds = elements
    .filter((element) => isInitializedImageElement(element))
    .map((element) => (element as { fileId: FileId }).fileId);

  if (!fileIds.length) {
    return {};
  }

  const { loadedFiles } = await loadFilesFromBackend(
    `${FILE_STORAGE_PREFIXES.collabFiles}/${boardId}`,
    boardKey,
    fileIds,
  );

  const files: BinaryFiles = {};
  for (const file of loadedFiles) {
    files[file.id] = file;
  }
  return files;
};

/**
 * Decrypts every board this device holds a key for and returns the bundle plus
 * the boards left out of it.
 *
 * Sequential on purpose: each board is a fetch, a decrypt and a second fetch
 * per image, and a hundred-board dashboard firing all of it at once buys
 * nothing on a LAN server while making the failure mode a thundering herd.
 */
export const buildBoardBundle = async (
  boards: readonly BoardListEntry[],
): Promise<{ bundle: LawhaBoardBundle; skipped: TransferSkip[] }> => {
  // No secure-context guard here. Exporting reads boards; it hashes nothing.
  // The one thing that needs crypto.subtle is decrypting a board written
  // before ADR 0012, and the loop below already catches that per board into
  // `skipped` — which names the affected board instead of refusing the other
  // ninety-nine. See `secureContextNote`.

  // The escrow sync that used to run here is gone with the escrow. It pulled
  // every key the account had escrowed into the local store so the loop below
  // would find boards this browser had never opened. Nothing needs a key to be
  // exported now; the only boards that still do are the handful stored before
  // ADR 0012, and for those the local store is the sole remaining source.

  const bundled: BundledBoard[] = [];
  const skipped: TransferSkip[] = [];

  for (const board of boards) {
    // Resolved rather than required, and NOT `getBoardKey`.
    //
    // This read the local store and skipped any board it missed, which was
    // right when a board was ciphertext and the key was the only way in. Every
    // board created since ADR 0012 has no key at all, so that check would have
    // made "export all my boards" quietly skip all the current ones and name
    // them in the report as unreadable — an export that looks complete and is
    // not is worse than one that fails.
    //
    // A key is still resolved because a board stored before ADR 0012 needs one,
    // and `resolveBoardKey` will ask the server for it. Null is passed through;
    // `loadFromBackend` throws only if the row it fetches turns out to be
    // encrypted and there is nothing to open it with, and that throw lands in
    // the catch below where it is reported per board.
    const boardKey = await resolveBoardKey(board.id, null);

    try {
      const elements = (await loadFromBackend(board.id, boardKey, null)) ?? [];
      const files = await collectFiles(board.id, boardKey, elements);

      bundled.push({
        id: board.id,
        name: board.name,
        linkAccess: board.linkAccess,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
        tagNames: board.tags.map((tag) => tag.name),
        // Round-tripped through JSON so the bundle is one document rather than
        // a document with strings of JSON embedded in it.
        scene: JSON.parse(serializeAsJSON(elements, {}, files, "local")),
      });
    } catch (caught) {
      skipped.push({ label: board.name, reason: reasonOf(caught) });
    }
  }

  return {
    bundle: {
      type: BUNDLE_TYPE,
      version: BUNDLE_VERSION,
      exportedAt: Date.now(),
      boards: bundled,
    },
    skipped,
  };
};

/**
 * Builds the bundle for the boards it is handed and gives it to the browser's
 * save picker.
 *
 * Takes a list rather than reaching for the whole dashboard, because the caller
 * is a selection: the user picks the boards and this exports those. What it
 * cannot do is turn a selection into a guarantee — a board is ciphertext plus a
 * key that only lives where its share link has been opened, so five selected
 * boards on a device holding three keys produce three, and `skipped` names the
 * other two.
 *
 * No file is written when nothing could be decrypted: a bundle with zero boards
 * in it reads as a successful backup and is the exact opposite.
 */
export const exportBoards = async (
  boards: readonly BoardListEntry[],
): Promise<ExportReport> => {
  const { bundle, skipped } = await buildBoardBundle(boards);
  const name = `lawha-boards-${isoDay(bundle.exportedAt)}`;

  if (!bundle.boards.length) {
    return { kind: "export", filename: null, exported: [], skipped };
  }

  await fileSave(
    new Blob([JSON.stringify(bundle, null, 2)], { type: MIME_TYPES.json }),
    {
      name,
      extension: "json",
      description: "Lawha boards",
      mimeTypes: [MIME_TYPES.json],
    },
  );

  return {
    kind: "export",
    filename: `${name}.json`,
    exported: bundle.boards.map((board) => board.name),
    skipped,
  };
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Writes a scene exactly once, for a board id minted moments ago.
 *
 * The four-line encrypt body is duplicated from `data/storage/lawha.ts` rather
 * than shared, because that module is owned elsewhere and — more to the point —
 * the two want different behaviour. `X-Lawha-Expected-Rev: ""` means "I have
 * never seen a stored scene: create if absent", and the server honours it only
 * while no row exists; a second write carrying it comes back 409.
 *
 * There is therefore **no compare-and-swap retry loop here, and there must not
 * be one.** Retrying would mean reconciling against a scene that, for an id
 * generated seconds ago and never opened, could only have arrived from
 * somewhere this import has no business merging with. A 409 is a bug, not a
 * race, and it is reported as a failure.
 *
 * Valid ONLY for a freshly minted board id.
 */
export const putSceneOnce = async (
  boardId: string,
  elements: readonly ExcalidrawElement[],
): Promise<void> => {
  const response = await fetch(`/api/boards/${boardId}/scene`, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Lawha-Expected-Rev": "",
      "X-Lawha-Scene-Version": String(getSceneVersion(elements)),
      // No `X-Lawha-Iv`: its absence is what tells the server the body is
      // plaintext JSON (ADR 0012). An imported board is therefore born in the
      // clear and never needs converting.
    },
    body: new TextEncoder().encode(JSON.stringify(elements)),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "a board already exists under that id"
        : `the server refused the scene (${response.status})`,
    );
  }
};

/**
 * Uploads the images a scene carries.
 *
 * @returns how many failed, so the report can say so instead of leaving the
 * board with placeholders and no explanation.
 */
const putFilesOnce = async (
  boardId: string,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
): Promise<number> => {
  const wanted = new Map<FileId, BinaryFileData>();
  for (const element of elements) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      wanted.set(element.fileId, files[element.fileId]);
    }
  }

  if (!wanted.size) {
    return 0;
  }

  const encoded = await encodeFilesForUpload({
    files: wanted,
    maxBytes: FILE_UPLOAD_MAX_BYTES,
  });

  const { erroredFiles } = await saveFilesToBackend({
    prefix: `${FILE_STORAGE_PREFIXES.collabFiles}/${boardId}`,
    files: encoded,
  });

  return erroredFiles.length;
};

/** One selected file, expanded into the boards it actually carries. */
interface PendingBoard {
  name: string;
  blob: Blob;
  tagNames: string[];
}

/**
 * A bundle becomes N boards; anything else stays one.
 *
 * The original `File` — not a re-wrapped copy — is handed back for the plain
 * case, because `loadFromBlob` also reads scenes out of PNG metadata and that
 * path needs the bytes and the mime type intact.
 */
const expandFile = async (file: File): Promise<PendingBoard[]> => {
  const single = (): PendingBoard[] => [
    {
      name: stripExtension(file.name) || "Imported board",
      blob: file,
      tagNames: [],
    },
  ];

  // Images can only ever be single scenes, and reading a multi-megabyte PNG as
  // text to find out otherwise would be silly.
  if (file.type.startsWith("image/")) {
    return single();
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await readAsText(file));
  } catch {
    // Not JSON at all, or unreadable. loadFromBlob gets to produce the error.
    return single();
  }

  const bundle = parsed as Partial<LawhaBoardBundle> | null;
  if (bundle?.type !== BUNDLE_TYPE || !Array.isArray(bundle.boards)) {
    return single();
  }

  return bundle.boards.map((entry, index) => ({
    name:
      typeof entry?.name === "string" && entry.name.trim()
        ? entry.name
        : `Imported board ${index + 1}`,
    blob: new Blob([JSON.stringify(entry?.scene ?? null)], {
      type: MIME_TYPES.excalidraw,
    }),
    tagNames: Array.isArray(entry?.tagNames)
      ? entry.tagNames.filter((tag): tag is string => typeof tag === "string")
      : [],
  }));
};

/**
 * Imports every selected file, each in its own try/catch.
 *
 * One malformed file must not abort the batch — the failure mode of a bulk
 * import that stops at the first bad file is a user who does not know which
 * half landed.
 */
export const importBoardsFromFiles = async (
  files: readonly File[],
): Promise<ImportReport> => {
  const imported: string[] = [];
  const importedIds: string[] = [];
  const failed: TransferSkip[] = [];
  const notes: string[] = [];

  // Reported, not refused. Importing DOES hash image bytes, so on a plain-http
  // origin the ids are random and duplicates stop collapsing — a real cost,
  // and a small one next to "import does not work". Saying so in the report is
  // the difference between a known trade and a silent one.
  const degraded = secureContextNote();
  if (degraded) {
    notes.push(degraded);
  }
  let droppedTags = 0;

  for (const file of files) {
    let pending: PendingBoard[];
    try {
      pending = await expandFile(file);
    } catch (caught) {
      failed.push({ label: file.name, reason: reasonOf(caught) });
      continue;
    }

    for (const entry of pending) {
      try {
        const scene = await loadFromBlob(entry.blob, null, null);
        const elements = getSyncableElements(
          scene.elements as readonly OrderedExcalidrawElement[],
        );

        // An id and nothing else. This mirrored `HomeRoute.onNewBoard`'s old
        // dance — mint a key, store it before the board row, escrow it after —
        // which existed because the escrow write had to follow a board the
        // server had heard of. An imported board is plaintext from its first
        // write, so none of that applies.
        const roomId = await generateBoardId();
        await createBoard({ id: roomId, name: entry.name });
        await putSceneOnce(roomId, elements);

        const erroredFiles = await putFilesOnce(
          roomId,
          elements,
          scene.files ?? {},
        );
        if (erroredFiles > 0) {
          notes.push(
            `${entry.name}: ${erroredFiles} image${
              erroredFiles === 1 ? "" : "s"
            } could not be uploaded and will show as missing.`,
          );
        }

        imported.push(entry.name);
        importedIds.push(roomId);
        droppedTags += entry.tagNames.length ? 1 : 0;
      } catch (caught) {
        failed.push({ label: entry.name, reason: reasonOf(caught) });
      }
    }
  }

  if (droppedTags > 0) {
    notes.push(
      `Tags were not restored on ${droppedTags} board${
        droppedTags === 1 ? "" : "s"
      } — tags belong to an account, not to a file. Reapply them here.`,
    );
  }

  return { kind: "import", imported, importedIds, failed, notes };
};

/** The picker. Deliberately permissive: iOS will not offer `.excalidraw` files. */
export const pickBoardFiles = async (): Promise<File[]> =>
  fileOpen({
    description: "Excalidraw boards and Lawha bundles",
    multiple: true,
  });
