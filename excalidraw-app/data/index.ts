import {
  compressData,
  decompressData,
} from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  generateEncryptionKey,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { isInvisiblySmallElement } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";
import { bytesToHexString } from "@excalidraw/common";

import type { UserIdleState } from "@excalidraw/common";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { SceneBounds } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { MakeBrand } from "@excalidraw/common/utility-types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_STORAGE_PREFIXES,
  FILE_UPLOAD_MAX_BYTES,
  ROOM_ID_BYTES,
} from "../app_constants";

import { getCurrentBoardKey } from "./currentBoard";
import { saveFilesToBackend } from "./storage";

import type { WS_SUBTYPES } from "../app_constants";

export type SyncableExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"SyncableExcalidrawElement">;

export const isSyncableElement = (
  element: OrderedExcalidrawElement,
): element is SyncableExcalidrawElement => {
  if (element.isDeleted) {
    if (element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT) {
      return true;
    }
    return false;
  }
  return !isInvisiblySmallElement(element);
};

export const getSyncableElements = (
  elements: readonly OrderedExcalidrawElement[],
) =>
  elements.filter((element) =>
    isSyncableElement(element),
  ) as SyncableExcalidrawElement[];

const BACKEND_V2_GET = import.meta.env.VITE_APP_BACKEND_V2_GET_URL;
const BACKEND_V2_POST = import.meta.env.VITE_APP_BACKEND_V2_POST_URL;

/**
 * A fresh board id: 10 random bytes, hex.
 *
 * Exported because creating a board no longer mints a key to go with it.
 * Callers used `generateCollaborationLinkData` for the id and threw the key
 * away, which read as if the key still mattered — see ADR 0012.
 */
export const generateBoardId = async () => {
  const buffer = new Uint8Array(ROOM_ID_BYTES);
  window.crypto.getRandomValues(buffer);
  return bytesToHexString(buffer);
};

export type EncryptedData = {
  data: ArrayBuffer;
  iv: Uint8Array;
};

export type SocketUpdateDataSource = {
  INVALID_RESPONSE: {
    type: WS_SUBTYPES.INVALID_RESPONSE;
  };
  SCENE_INIT: {
    type: WS_SUBTYPES.INIT;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  SCENE_UPDATE: {
    type: WS_SUBTYPES.UPDATE;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  MOUSE_LOCATION: {
    type: WS_SUBTYPES.MOUSE_LOCATION;
    payload: {
      socketId: SocketId;
      pointer: {
        x: number;
        y: number;
        tool: "pointer" | "laser";
        /**
         * Palette *indices*, not colours. The interactive canvas is filtered
         * in dark mode, so which of an entry's two hexes is correct depends on
         * the receiver's theme, not the sender's — resolving here would paint
         * every remote cursor wrong for anyone on the opposite theme.
         */
        colorIndex?: number | null;
        laserColorIndex?: number | null;
      };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  USER_VISIBLE_SCENE_BOUNDS: {
    type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS;
    payload: {
      socketId: SocketId;
      username: string;
      sceneBounds: SceneBounds;
    };
  };
  IDLE_STATUS: {
    type: WS_SUBTYPES.IDLE_STATUS;
    payload: {
      socketId: SocketId;
      userState: UserIdleState;
      username: string;
    };
  };
};

export type SocketUpdateDataIncoming =
  SocketUpdateDataSource[keyof SocketUpdateDataSource];

export type SocketUpdateData =
  SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
    _brand: "socketUpdateData";
  };

/** Legacy Excalidraw form. Still accepted so existing links keep working. */
const RE_COLLAB_LINK = /^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

/**
 * Lawha board links: `/b/<boardId>`.
 *
 * The board id moves into the path because it is not a secret — access is
 * enforced server-side by `resolveBoardPermission`, which is a stronger
 * guarantee than "the id is unguessable".
 *
 * The `#key=` fragment is still PARSED and no longer MINTED. Boards are stored
 * in the clear (ADR 0012), so a link needs to carry nothing but the id; but
 * every link handed out before that change has a fragment on it, and a board
 * stored before it still needs that key to be read the first time. Accepting
 * what we no longer emit is the whole of the compatibility story.
 */
const RE_BOARD_PATH = /^\/b\/([a-zA-Z0-9_-]+)\/?$/;
const RE_BOARD_KEY_HASH = /^#key=([a-zA-Z0-9_-]+)$/;

/** AES-GCM 128-bit JWK `k`, base64url. */
const ROOM_KEY_LENGTH = 22;

/**
 * Board ids are shown grouped (`8f3a-c19d`) but stored and transmitted flat.
 * Grouping is presentation only, so dashes are stripped on the way in.
 */
const normalizeBoardId = (boardId: string) => boardId.replace(/-/g, "");

/**
 * Reads a board link, or returns null if it is not one.
 *
 * A pure function, deliberately. It used to `window.alert` when a `/b/<id>`
 * path arrived without a key, and that single line hung the whole app: opening
 * a board from the dashboard navigates to a clean `/b/<id>` — the key is
 * already on the device, so putting it in the URL would be pointless — and a
 * native alert blocks the renderer's main thread until it is dismissed. It
 * read as a frozen tab, not as a dialog.
 *
 * So a missing fragment is not an error here. The key is looked up for the
 * open board instead, and callers that have somewhere to put a message (the
 * board route's "locked here" panel) report the genuine failure: no key
 * anywhere, from the link or from this device.
 */
export const getBoardLinkData = (link: string) => {
  const url = new URL(link);

  const pathMatch = url.pathname.match(RE_BOARD_PATH);
  if (pathMatch) {
    const roomId = normalizeBoardId(pathMatch[1]);
    const keyMatch = url.hash.match(RE_BOARD_KEY_HASH);
    const roomKey =
      keyMatch && keyMatch[1].length === ROOM_KEY_LENGTH
        ? keyMatch[1]
        : getCurrentBoardKey(roomId);

    // **A missing key is no longer a missing link.** This returned null without
    // one, which made `isCollaborationLink` false, which meant `/b/<id>` did
    // not join its room — invariant 25, broken for every board created since
    // scenes became plaintext, because those boards have no key to find. The
    // room id is the link; the key is an optional legacy attachment to it.
    return { roomId, roomKey };
  }

  const hashMatch = url.hash.match(RE_COLLAB_LINK);
  if (!hashMatch || hashMatch[2].length !== ROOM_KEY_LENGTH) {
    return null;
  }
  return { roomId: hashMatch[1], roomKey: hashMatch[2] };
};

/**
 * Derived from the parser rather than re-matching the URL, so the two cannot
 * disagree — and they did: a `#key=` of the wrong length made this true while
 * the parser returned null, which is the shape of every "collaborating with
 * nothing" bug.
 */
export const isCollaborationLink = (link: string) =>
  getBoardLinkData(link) !== null;

/** Kept as an alias so existing call sites read unchanged. */
export const getCollaborationLinkData = getBoardLinkData;

export const generateCollaborationLinkData = async () => {
  const roomId = await generateBoardId();
  const roomKey = await generateEncryptionKey();

  if (!roomKey) {
    throw new Error("Couldn't generate room key");
  }

  return { roomId, roomKey };
};

/**
 * The link to a board — the id, and nothing else.
 *
 * The `#key=` fragment is gone from what we hand out. It was the board key,
 * which the server never held; it holds every key now (ADR 0011) and the scene
 * is not encrypted at all (ADR 0012), so a fragment would be decoration that
 * makes a link harder to paste into a chat window.
 *
 * **What this costs, stated rather than assumed:** the board id is now the
 * entire secret in a share link, and unlike a fragment a path IS sent to the
 * server and lands in its access log. The id is 10 random bytes
 * (`ROOM_ID_BYTES`) and `link_access` still has to be on for the link to open
 * anything, so this is a narrower change than it looks — but it is a real one.
 */
export const getCollaborationLink = (data: { roomId: string }) => {
  return `${window.location.origin}/b/${data.roomId}`;
};

/** Grouped for display only — never parsed back in this form. */
export const formatBoardIdForDisplay = (boardId: string) =>
  boardId.match(/.{1,4}/g)?.join("-") ?? boardId;

/**
 * Decodes shareLink data using the legacy buffer format.
 * @deprecated
 */
const legacy_decodeFromBackend = async ({
  buffer,
  decryptionKey,
}: {
  buffer: ArrayBuffer;
  decryptionKey: string;
}) => {
  let decrypted: ArrayBuffer;

  try {
    // Buffer should contain both the IV (fixed length) and encrypted data
    const iv = buffer.slice(0, IV_LENGTH_BYTES);
    const encrypted = buffer.slice(IV_LENGTH_BYTES, buffer.byteLength);
    decrypted = await decryptData(new Uint8Array(iv), encrypted, decryptionKey);
  } catch (error: any) {
    // Fixed IV (old format, backward compatibility)
    const fixedIv = new Uint8Array(IV_LENGTH_BYTES);
    decrypted = await decryptData(fixedIv, buffer, decryptionKey);
  }

  // We need to convert the decrypted array buffer to a string
  const string = new window.TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  const data: ImportedDataState = JSON.parse(string);

  return {
    elements: data.elements || null,
    appState: data.appState || null,
  };
};

export const importFromBackend = async (
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> => {
  try {
    const response = await fetch(`${BACKEND_V2_GET}${id}`);

    if (!response.ok) {
      throw new Error(t("alerts.importBackendFailed"));
    }
    const buffer = await response.arrayBuffer();

    try {
      const { data: decodedBuffer } = await decompressData(
        new Uint8Array(buffer),
        {
          decryptionKey,
        },
      );
      const data: ImportedDataState = JSON.parse(
        new TextDecoder().decode(decodedBuffer),
      );

      return {
        elements: data.elements || null,
        appState: data.appState || null,
      };
    } catch (error: any) {
      console.warn(
        "error when decoding shareLink data using the new format:",
        error,
      );
      return legacy_decodeFromBackend({ buffer, decryptionKey });
    }
  } catch (error: any) {
    // Reported to the caller rather than shown from here. This used to
    // `window.alert`, which blocks the renderer's main thread (invariant 19)
    // and — worse for a data path — swallowed the failure into an empty scene,
    // so a link that could not be fetched looked like a link to a blank board.
    console.error(error);
    throw error instanceof Error
      ? error
      : new Error(t("alerts.importBackendFailed"));
  }
};

type ExportToBackendResult =
  | { url: null; errorMessage: string }
  | { url: string; errorMessage: null };

export const exportToBackend = async (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): Promise<ExportToBackendResult> => {
  const encryptionKey = await generateEncryptionKey("string");

  const payload = await compressData(
    new TextEncoder().encode(
      serializeAsJSON(elements, appState, files, "database"),
    ),
    { encryptionKey },
  );

  try {
    const filesMap = new Map<FileId, BinaryFileData>();
    for (const element of elements) {
      if (isInitializedImageElement(element) && files[element.fileId]) {
        filesMap.set(element.fileId, files[element.fileId]);
      }
    }

    /*
     * Encrypted here, and NOT through `encodeFilesForUpload`, which stopped
     * encrypting under ADR 0012.
     *
     * That decision was about Lawha's own storage: the server already held a
     * copy of every key, so the encryption bought nothing and cost the
     * locked-board screen. **None of that reasoning reaches this function.**
     * `BACKEND_V2_POST` is upstream Excalidraw's public service — a third
     * party, on the internet, that has never held a key and must not start —
     * and the fragment below is the only place the key exists. Uploading these
     * bytes in the clear would be publishing somebody's drawing.
     *
     * The path is inert in production (`.env.production` blanks both URLs, and
     * `ShareDialog` says so) but it is live in dev against
     * json-dev.excalidraw.com, so this is a real upload and not a dead branch.
     */
    const filesToUpload = await Promise.all(
      [...filesMap].map(async ([id, fileData]) => {
        const buffer = new TextEncoder().encode(fileData.dataURL);

        // The size guard `encodeFilesForUpload` used to apply on this path.
        // Checked BEFORE the encode, as it was there: compressing and
        // encrypting a file that is about to be rejected is work thrown away.
        // Restoring it explicitly rather than letting it lapse — dropping it
        // silently would have raised the effective ceiling on this route only,
        // which is the kind of divergence nobody finds until an upload fails
        // somewhere else for a reason that no longer matches.
        if (buffer.byteLength > FILE_UPLOAD_MAX_BYTES) {
          throw new Error(
            t("errors.fileTooBig", {
              maxSize: `${Math.trunc(FILE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB`,
            }),
          );
        }

        return {
          id,
          buffer: await compressData<BinaryFileMetadata>(buffer, {
            encryptionKey,
            metadata: {
              id,
              mimeType: fileData.mimeType,
              created: Date.now(),
              lastRetrieved: Date.now(),
            },
          }),
        };
      }),
    );

    const response = await fetch(BACKEND_V2_POST, {
      method: "POST",
      body: payload.buffer,
    });
    const json = await response.json();
    if (json.id) {
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      url.hash = `json=${json.id},${encryptionKey}`;
      const urlString = url.toString();

      await saveFilesToBackend({
        prefix: `${FILE_STORAGE_PREFIXES.shareLinkFiles}/${json.id}`,
        files: filesToUpload,
      });

      return { url: urlString, errorMessage: null };
    } else if (json.error_class === "RequestTooLargeError") {
      return {
        url: null,
        errorMessage: t("alerts.couldNotCreateShareableLinkTooBig"),
      };
    }

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  } catch (error: any) {
    console.error(error);

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  }
};
