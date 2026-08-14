import { getSceneVersion } from "@excalidraw/element";
import { toBrandedType } from "@excalidraw/common";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import type { StorageBackend } from "./types";
import type { SyncableExcalidrawElement } from "..";

/**
 * In-memory backend for tests: no network, no encryption, no server.
 *
 * It deliberately keeps plaintext elements rather than ciphertext — tests care
 * about the call contract, not the crypto, which is covered separately.
 */
const scenes = new Map<string, readonly SyncableExcalidrawElement[]>();
const files = new Map<string, Uint8Array>();
const savedVersions = new Map<string, number>();

export const resetMemoryBackend = (): void => {
  scenes.clear();
  files.clear();
  savedVersions.clear();
};

export const memoryBackend: StorageBackend = {
  isSavedToBackend: (portal, elements) => {
    if (!portal.roomId) {
      return true;
    }
    return savedVersions.get(portal.roomId) === getSceneVersion(elements);
  },

  saveToBackend: async (portal, elements) => {
    if (!portal.roomId) {
      return null;
    }
    scenes.set(portal.roomId, elements);
    savedVersions.set(portal.roomId, getSceneVersion(elements));
    return toBrandedType<RemoteExcalidrawElement[]>(
      elements as unknown as RemoteExcalidrawElement[],
    );
  },

  loadFromBackend: async (roomId) => scenes.get(roomId) ?? null,

  saveFilesToBackend: async ({ prefix, files: toSave }) => {
    const savedFiles: FileId[] = [];
    for (const { id, buffer } of toSave) {
      files.set(`${prefix}/${id}`, buffer);
      savedFiles.push(id);
    }
    return { savedFiles, erroredFiles: [] };
  },

  loadFilesFromBackend: async (prefix, _decryptionKey, fileIds) => {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();
    for (const id of fileIds) {
      if (!files.has(`${prefix}/${id}`)) {
        erroredFiles.set(id, true);
      }
    }
    return { loadedFiles, erroredFiles };
  },
};
