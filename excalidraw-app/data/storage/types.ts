import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import type Portal from "../../collab/Portal";
import type { SyncableExcalidrawElement } from "..";
import type { Socket } from "socket.io-client";

/**
 * Persistence for collaborative scenes and their image files.
 *
 * Signatures deliberately mirror the Firebase module this replaced, so the
 * call sites in Collab.tsx / App.tsx changed by name only.
 *
 * **Scenes and files are stored in the clear.** They were client-side
 * encrypted, with the room key in the URL fragment; that bought nothing once
 * the server held a copy of every account's master key (ADR 0011) and it cost
 * the locked-board screen, so it went (ADR 0012). Authorization is
 * `resolveBoardPermission` on the server and nothing else.
 *
 * The `roomKey` arguments below survive **only to read what was written before
 * that change**, which is why they are nullable: a board created since has no
 * key, and a legacy board on a browser that cannot obtain one cannot be read at
 * all. They go when the last stored ciphertext does.
 */
export interface StorageBackend {
  /**
   * Whether the current scene is already persisted for this socket. Cached, so
   * it is cheap enough to call on every unload check.
   */
  isSavedToBackend: (
    portal: Portal,
    elements: readonly ExcalidrawElement[],
  ) => boolean;

  /**
   * Persists `elements` for `portal.roomId`.
   *
   * @returns the elements as finally stored — which may differ from those
   * passed in, if a concurrent write had to be reconciled — or null when there
   * was nothing to write.
   */
  saveToBackend: (
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ) => Promise<RemoteExcalidrawElement[] | null>;

  loadFromBackend: (
    roomId: string,
    /** Legacy only: needed if and only if the stored scene is still encrypted. */
    roomKey: string | null,
    socket: Socket | null,
  ) => Promise<readonly SyncableExcalidrawElement[] | null>;

  /**
   * Uploads already-encoded file buffers.
   *
   * Returns **arrays of ids** — not Maps. `Collab.saveFiles` calls
   * `savedFiles.reduce(...)` on the result, which throws on a Map; a test
   * double that returns Maps therefore passes while asserting nothing (see
   * invariant 15).
   *
   * @throws {StorageError} when the server refuses in a way retrying cannot
   * fix (401 / 403 / 413). The rejection is what reaches
   * `Portal.queueFileUpload`'s catch and puts a message in front of the user;
   * a status collected into `erroredFiles` is silent by construction.
   */
  saveFilesToBackend: (opts: {
    /** `files/rooms/<boardId>` or `files/shareLinks/<shareId>` */
    prefix: string;
    files: { id: FileId; buffer: Uint8Array }[];
  }) => Promise<{ savedFiles: FileId[]; erroredFiles: FileId[] }>;

  /** Returns loaded file *data*, and errored ids as a `Map<FileId, true>`. */
  loadFilesFromBackend: (
    prefix: string,
    /** Legacy only: needed if and only if the stored file is still encrypted. */
    decryptionKey: string | null,
    fileIds: readonly FileId[],
  ) => Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }>;
}

/** Raised when the server rejects a request for reasons the UI should surface. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
