import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";

import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
  InitializedExcalidrawImageElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { FILE_UPLOAD_MAX_BYTES } from "../app_constants";

import { encodeFile } from "./fileEncoding";

type FileVersion = Required<BinaryFileData>["version"];

/**
 * A fetch that fails is not proof the file is gone: the peer that owns it may
 * still be uploading, the network may have blinked, or the session may have
 * been re-established since. Before this, one failure marked the id tracked
 * forever and it was never requested again for the rest of the session.
 *
 * The retry is *bounded* on both axes — an unbounded retry against a genuinely
 * deleted file is a request storm, which is the bug in the other direction.
 */
export const FILE_FETCH_RETRY_BASE_MS = 10_000;
export const FILE_FETCH_MAX_ATTEMPTS = 3;

/** How long a failed id waits before it may be requested again. */
export const getFileFetchRetryDelay = (attempts: number) =>
  FILE_FETCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

type FetchFailure = { attempts: number; lastAttemptAt: number };

/**
 * The client measures the base64 `dataURL`, not the binary it decodes to, so
 * the effective ceiling is roughly three quarters of the constant. Deliberate:
 * the number has to agree with the editor's own insert cap and with
 * `FILE_UPLOAD_MAX_BYTES` on the server, and only one of the three lives here.
 */
export const getUploadByteLength = (file: BinaryFileData) =>
  new TextEncoder().encode(file.dataURL).byteLength;

export class FileManager {
  /** files being fetched */
  private fetchingFiles = new Map<ExcalidrawImageElement["fileId"], true>();
  private erroredFiles_fetch = new Map<
    ExcalidrawImageElement["fileId"],
    FetchFailure
  >();
  /** files being saved */
  private savingFiles = new Map<
    ExcalidrawImageElement["fileId"],
    FileVersion
  >();
  /* files already saved to persistent storage */
  private savedFiles = new Map<ExcalidrawImageElement["fileId"], FileVersion>();
  private erroredFiles_save = new Map<
    ExcalidrawImageElement["fileId"],
    FileVersion
  >();
  /**
   * Files rejected locally for exceeding the upload ceiling. Kept apart from
   * `erroredFiles_save` (which they also join) so the failure is reported to
   * the user exactly once per version rather than on every throttled tick.
   */
  private oversizedFiles = new Map<
    ExcalidrawImageElement["fileId"],
    FileVersion
  >();

  private _getFiles;
  private _saveFiles;
  private _onFileStatusChange;
  /**
   * Overridable for tests only; the default is the one number the app, the
   * editor's insert cap and the server all have to agree on.
   */
  private maxUploadBytes: number;

  constructor({
    getFiles,
    saveFiles,
    onFileStatusChange,
    maxUploadBytes = FILE_UPLOAD_MAX_BYTES,
  }: {
    getFiles: (fileIds: FileId[]) => Promise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>;
    saveFiles: (data: { addedFiles: Map<FileId, BinaryFileData> }) => Promise<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }>;
    onFileStatusChange?: (
      updates: Array<[FileId, "loading" | "loaded" | "error"]>,
    ) => void;
    maxUploadBytes?: number;
  }) {
    this._getFiles = getFiles;
    this._saveFiles = saveFiles;
    this._onFileStatusChange = onFileStatusChange;
    this.maxUploadBytes = maxUploadBytes;
  }

  /**
   * Whether the file is saved, being processed, or written off.
   *
   * A `true` here is what keeps `Collab.fetchImageFilesFromBackend` from
   * asking for the file again, so a failed *fetch* must not answer `true`
   * forever: the file may simply not have landed yet. It stays tracked while
   * the backoff for its attempt count is running, and permanently only once
   * the attempts are exhausted.
   */
  isFileTracked = (id: FileId) => {
    if (
      this.savedFiles.has(id) ||
      this.savingFiles.has(id) ||
      this.fetchingFiles.has(id) ||
      this.erroredFiles_save.has(id)
    ) {
      return true;
    }

    const failure = this.erroredFiles_fetch.get(id);
    if (!failure) {
      return false;
    }
    if (failure.attempts >= FILE_FETCH_MAX_ATTEMPTS) {
      return true;
    }
    return (
      Date.now() - failure.lastAttemptAt <
      getFileFetchRetryDelay(failure.attempts)
    );
  };

  isFileSavedOrBeingSaved = (file: BinaryFileData) => {
    const fileVersion = this.getFileVersion(file);
    return (
      this.savedFiles.get(file.id) === fileVersion ||
      this.savingFiles.get(file.id) === fileVersion
    );
  };

  getFileVersion = (file: BinaryFileData) => {
    return file.version ?? 1;
  };

  saveFiles = async ({
    elements,
    files,
  }: {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
  }) => {
    const addedFiles: Map<FileId, BinaryFileData> = new Map();
    /** Rejected here, and reported to the caller once each. */
    const oversizedFiles: Map<FileId, BinaryFileData> = new Map();

    for (const element of elements) {
      const fileData =
        isInitializedImageElement(element) && files[element.fileId];

      if (!fileData || this.isFileSavedOrBeingSaved(fileData)) {
        continue;
      }

      const fileVersion = this.getFileVersion(fileData);

      // Already rejected at this version: neither retried nor re-reported.
      if (this.oversizedFiles.get(element.fileId) === fileVersion) {
        continue;
      }

      // Screened *before* `_saveFiles`, because the encoder throws on the
      // first file over the ceiling and that rejection takes the whole batch
      // with it — one 5MiB image and none of the small ones beside it upload,
      // on this attempt or any later one.
      if (getUploadByteLength(fileData) > this.maxUploadBytes) {
        this.oversizedFiles.set(element.fileId, fileVersion);
        this.erroredFiles_save.set(element.fileId, fileVersion);
        oversizedFiles.set(element.fileId, fileData);
        continue;
      }

      addedFiles.set(element.fileId, fileData);
      this.savingFiles.set(element.fileId, fileVersion);
    }

    try {
      const { savedFiles, erroredFiles } = await this._saveFiles({
        addedFiles,
      });

      for (const [fileId, fileData] of savedFiles) {
        this.savedFiles.set(fileId, this.getFileVersion(fileData));
      }

      for (const [fileId, fileData] of erroredFiles) {
        this.erroredFiles_save.set(fileId, this.getFileVersion(fileData));
      }

      return {
        savedFiles,
        erroredFiles: new Map([...erroredFiles, ...oversizedFiles]),
        oversizedFiles,
      };
    } finally {
      for (const [fileId] of addedFiles) {
        this.savingFiles.delete(fileId);
      }
    }
  };

  /** The message `Portal.queueFileUpload` puts in front of the user. */
  static describeOversizedFiles = (count: number) =>
    `${t("errors.fileTooBig", {
      maxSize: `${Math.trunc(FILE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`,
    })}${count > 1 ? ` (${count} images)` : ""}`;

  getFiles = async (
    ids: FileId[],
  ): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }> => {
    if (!ids.length) {
      return {
        loadedFiles: [],
        erroredFiles: new Map(),
      };
    }
    for (const id of ids) {
      this.fetchingFiles.set(id, true);
    }

    this._onFileStatusChange?.(ids.map((id) => [id, "loading"]));

    try {
      const { loadedFiles, erroredFiles } = await this._getFiles(ids);

      for (const file of loadedFiles) {
        this.savedFiles.set(file.id, this.getFileVersion(file));
        // A retry that landed clears the record, so a later failure starts
        // its own budget rather than inheriting an exhausted one.
        this.erroredFiles_fetch.delete(file.id);
      }
      for (const [fileId] of erroredFiles) {
        const previous = this.erroredFiles_fetch.get(fileId);
        this.erroredFiles_fetch.set(fileId, {
          attempts: (previous?.attempts ?? 0) + 1,
          lastAttemptAt: Date.now(),
        });
      }

      this._onFileStatusChange?.([
        ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
        ...[...erroredFiles.keys()].map(
          (id) => [id, "error"] as [FileId, "error"],
        ),
      ]);

      return { loadedFiles, erroredFiles };
    } finally {
      for (const id of ids) {
        this.fetchingFiles.delete(id);
      }
    }
  };

  /** a file element prevents unload only if it's being saved regardless of
   *  its `status`. This ensures that elements who for any reason haven't
   *  beed set to `saved` status don't prevent unload in future sessions.
   *  Technically we should prevent unload when the origin client haven't
   *  yet saved the `status` update to storage, but that should be taken care
   *  of during regular beforeUnload unsaved files check.
   */
  shouldPreventUnload = (elements: readonly ExcalidrawElement[]) => {
    return elements.some((element) => {
      return (
        isInitializedImageElement(element) &&
        !element.isDeleted &&
        this.savingFiles.has(element.fileId)
      );
    });
  };

  /**
   * helper to determine if image element status needs updating
   */
  shouldUpdateImageElementStatus = (
    element: ExcalidrawElement,
  ): element is InitializedExcalidrawImageElement => {
    return (
      isInitializedImageElement(element) &&
      this.savedFiles.has(element.fileId) &&
      element.status === "pending"
    );
  };

  reset() {
    if (this._onFileStatusChange && this.fetchingFiles.size) {
      this._onFileStatusChange(
        [...this.fetchingFiles.keys()].map(
          (id) => [id, "error"] as [FileId, "error"],
        ),
      );
    }
    this.fetchingFiles.clear();
    this.savingFiles.clear();
    this.savedFiles.clear();
    this.erroredFiles_fetch.clear();
    this.erroredFiles_save.clear();
    this.oversizedFiles.clear();
  }
}

/**
 * `encryptionKey` is gone from the parameters, not defaulted.
 *
 * Files are stored in the clear (ADR 0012). Leaving an ignored key argument
 * would have let every call site go on passing one and read as if encryption
 * were still happening — the parameter is removed so the compiler names each
 * place that has to be looked at.
 */
export const encodeFilesForUpload = async ({
  files,
  maxBytes,
}: {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
}) => {
  const processedFiles: {
    id: FileId;
    buffer: Uint8Array;
  }[] = [];

  for (const [id, fileData] of files) {
    const buffer = new TextEncoder().encode(fileData.dataURL);

    // Checked before the encode, not after: compressing and encrypting a file
    // we are about to reject is work thrown away. Callers that batch (see
    // `FileManager.saveFiles`) screen oversized files out ahead of this, since
    // this throw aborts the whole batch — this remains the backstop for the
    // single-file share-link path.
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        t("errors.fileTooBig", {
          maxSize: `${Math.trunc(maxBytes / 1024 / 1024)}MB`,
        }),
      );
    }

    processedFiles.push({
      id,
      buffer: encodeFile(buffer, {
        id,
        mimeType: fileData.mimeType,
        created: Date.now(),
        lastRetrieved: Date.now(),
      }),
    });
  }

  return processedFiles;
};

/**
 * Degrades image elements whose file could not be loaded.
 *
 * `status` lives on the element, and the element is *shared*: it is broadcast
 * to every peer and encrypted into the persisted scene. So "I could not fetch
 * this file" must not be written there — one peer's expired session, offline
 * moment or lost race against an in-flight upload would otherwise mark the
 * image permanently broken for everybody, including the author whose own copy
 * is sitting in their local files map. Worse, `status: "error"` is terminal:
 * `Collab.fetchImageFilesFromBackend` only ever re-fetches `"saved"` elements,
 * so the board can never recover on its own.
 *
 * An element that reached `"saved"` was confirmed uploaded by whoever added
 * it, so a failure to read it back is a statement about this client and is
 * left to the retry budget in `FileManager.isFileTracked` and to
 * `FileStatusStore`, both of which are local-only. Only elements that never
 * got that far — still `"pending"` — are degraded.
 */
export const updateStaleImageStatuses = (params: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  erroredFiles: Map<FileId, true>;
  elements: readonly ExcalidrawElement[];
}) => {
  if (!params.erroredFiles.size) {
    return;
  }

  let isChanged = false;
  const elements = params.excalidrawAPI
    .getSceneElementsIncludingDeleted()
    .map((element) => {
      if (
        isInitializedImageElement(element) &&
        params.erroredFiles.has(element.fileId) &&
        element.status === "pending"
      ) {
        isChanged = true;
        return newElementWith(element, {
          status: "error",
        });
      }
      return element;
    });

  // No write at all when nothing qualifies: an `updateScene` per failed fetch
  // is a render per failed fetch, and every one of them was a no-op.
  if (!isChanged) {
    return;
  }

  params.excalidrawAPI.updateScene({
    elements,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};
