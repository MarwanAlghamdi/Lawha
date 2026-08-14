import { lawhaBackend } from "./lawha";
import { memoryBackend } from "./memory";

import type { StorageBackend } from "./types";

/**
 * The single place a storage implementation is chosen.
 *
 * Call sites import the bound functions below rather than the backend object,
 * which is what let the Firebase swap be a rename at every call site.
 */
const backend: StorageBackend =
  import.meta.env.MODE === "test" ? memoryBackend : lawhaBackend;

export const isSavedToBackend = backend.isSavedToBackend;
export const saveToBackend = backend.saveToBackend;
export const loadFromBackend = backend.loadFromBackend;
export const saveFilesToBackend = backend.saveFilesToBackend;
export const loadFilesFromBackend = backend.loadFilesFromBackend;

export { lawhaBackend } from "./lawha";
export { memoryBackend, resetMemoryBackend } from "./memory";
export { parseFilePrefix } from "./prefix";
export type { StorageBackend } from "./types";
export { StorageError } from "./types";
