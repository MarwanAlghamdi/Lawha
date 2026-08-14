import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";

// Only the read half. Nothing here encrypts any more — a scene is written as
// plaintext JSON — but a board stored before that change still has to open,
// and it opens exactly once before being rewritten in the clear.
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { API_BASE, NGROK_SKIP_HEADER } from "../api";

import { decodeFile } from "../fileEncoding";

import { getSyncableElements } from "..";

import { parseFilePrefix } from "./prefix";
import { StorageError } from "./types";

import type { StorageBackend } from "./types";
import type Portal from "../../collab/Portal";
import type { SyncableExcalidrawElement } from "..";
import type { Socket } from "socket.io-client";

/** Must match SCENE_HEADERS in lawha-server/src/protocol.ts. */
const SCENE_HEADERS = {
  EXPECTED_REV: "X-Lawha-Expected-Rev",
  REV: "x-lawha-rev",
  SCENE_VERSION: "X-Lawha-Scene-Version",
  IV: "X-Lawha-Iv",
} as const;

/**
 * Bounded so a pathologically contended board fails loudly rather than
 * spinning. Collab.saveCollabRoomToBackend already surfaces the error.
 */
const MAX_CAS_RETRIES = 4;

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes as Uint8Array<ArrayBuffer>;
};

/**
 * Reads a stored scene, encrypted or not.
 *
 * **A zero-length iv means the body is plaintext JSON.** That is the marker the
 * whole migration off encryption turns on: it lets an old row and a new row
 * live in the same table, so boards convert as they are opened rather than in
 * one irreversible sweep. The server side of the convention is `parseIv` in
 * `lawha-server/src/http/routes/scene.ts`.
 *
 * The legacy branch needs a key, and `roomKey` can be null for a board whose
 * key this browser cannot get — an owner who has not signed in since migration
 * 010 has no server-recoverable master, so the handout 404s. That is why this
 * throws a named error rather than returning null: the caller is
 * `loadFromBackend`, and "there is no scene" and "there is a scene I cannot
 * read" must not arrive at the editor as the same blank canvas. Silence is the
 * bug; three features have been reported broken here when they were really
 * failing without saying so.
 */
class UnreadableSceneError extends Error {
  constructor(roomId: string) {
    super(
      `lawha: board ${roomId} is stored encrypted and no key for it is available ` +
        `on this browser. Open it once from a browser that has the key, or from ` +
        `its original share link, and it will be re-saved in the clear.`,
    );
    this.name = "UnreadableSceneError";
  }
}

const readElements = async (
  stored: StoredScene,
  roomId: string,
  roomKey: string | null,
): Promise<readonly ExcalidrawElement[]> => {
  if (stored.iv.byteLength === 0) {
    return JSON.parse(new TextDecoder("utf-8").decode(stored.ciphertext));
  }

  // The local store is the only source now. `GET /api/keys/boards/:id` handed
  // one out while the estate converted; migration 013 dropped the tables behind
  // it, because the server could not open the boards that are still stuck
  // anyway. What is left is the key this browser already holds.
  if (!roomKey) {
    throw new UnreadableSceneError(roomId);
  }

  const decrypted = await decryptData(stored.iv, stored.ciphertext, roomKey);
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(decrypted)));
};

interface StoredScene {
  rev: number;
  sceneVersion: number;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

const parseSceneResponse = async (
  response: Response,
): Promise<StoredScene> => ({
  rev: Number(response.headers.get(SCENE_HEADERS.REV) ?? 0),
  sceneVersion: Number(response.headers.get("x-lawha-scene-version") ?? 0),
  iv: fromHex(response.headers.get("x-lawha-iv") ?? ""),
  ciphertext: new Uint8Array(
    await response.arrayBuffer(),
  ) as Uint8Array<ArrayBuffer>,
});

/**
 * Tracks what each socket has successfully persisted, so an unchanged scene is
 * not re-serialised and re-sent. Carried over verbatim from the Firebase module.
 */
class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

/**
 * The server revision each socket last observed. This — not sceneVersion — is
 * the compare-and-swap token: sceneVersion is a sum of element versions, so a
 * client holding fewer elements can still produce a larger value.
 */
class RevCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => RevCache.cache.get(socket) ?? null;
  static set = (socket: Socket, rev: number) => {
    RevCache.cache.set(socket, rev);
  };
}

/**
 * Upload failures the user has to be told about, and which retrying cannot fix.
 *
 * Collecting these into `erroredFiles` and returning normally is silence: the
 * image element stays `pending` forever, no peer ever fetches it, and the
 * sender keeps seeing their own copy out of the local files map, so nothing
 * anywhere looks wrong. Throwing hands them to `Portal.queueFileUpload`, whose
 * catch is the one place in the app that surfaces a file error to the user.
 *
 * Transient failures (network, 5xx) stay in `erroredFiles` so they are retried.
 */
const FATAL_UPLOAD_STATUS_MESSAGES: Readonly<Record<number, string>> = {
  401: "You are signed out, so the image could not be uploaded. Sign in and try again.",
  403: "You do not have permission to add images to this board.",
  413: "The image is too large to upload.",
};

/**
 * Rewrites a board's stored scene in the clear, once, at the revision it was
 * read at.
 *
 * `expectedRev` is the compare-and-swap token and passing the observed one is
 * the safety: if anybody wrote in between, this loses the race with a 409 and
 * does nothing — which is right, because whoever won has already written
 * plaintext through `saveToBackend`. There is deliberately no retry loop; a
 * conversion that fights for the write would be competing with a live editing
 * session over a board it is only tidying.
 *
 * Reports its failures. A silent converter is how "we migrated everything"
 * becomes false without anyone noticing, and the count of boards still
 * encrypted is the gate on deleting the key material at all.
 */
const rewriteAsPlaintext = async (
  roomId: string,
  elements: readonly ExcalidrawElement[],
  expectedRev: number,
): Promise<void> => {
  const response = await fetch(`${API_BASE}/boards/${roomId}/scene`, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      ...NGROK_SKIP_HEADER,
      "Content-Type": "application/octet-stream",
      [SCENE_HEADERS.EXPECTED_REV]: String(expectedRev),
      [SCENE_HEADERS.SCENE_VERSION]: String(getSceneVersion(elements)),
    },
    body: new TextEncoder().encode(JSON.stringify(elements)),
  });

  if (response.ok) {
    console.info(`lawha: board ${roomId} converted to plaintext storage`);
    return;
  }

  // 403 is the ordinary case and not a fault: a viewer can read a board and
  // cannot write it, so the conversion has to wait for somebody who can.
  console.warn(
    `lawha: could not convert board ${roomId} to plaintext storage (${response.status}); ` +
      `it stays encrypted and will be retried the next time somebody who can ` +
      `write it opens it`,
  );
};

export const lawhaBackend: StorageBackend = {
  isSavedToBackend: (portal, elements) => {
    // `portal.roomKey` is NOT part of this condition, and must never be added
    // back. It was, and the consequence was the worst failure this app can
    // have: every board created since ADR 0012 has no key — the `#key=`
    // fragment is gone from handed-out links and `getCurrentBoardKey` only
    // holds keys for boards written before scenes went plaintext — so this
    // fell through to `return true` and the canvas reported a green "Saved"
    // for work that `saveToBackend` was, for the same reason, never sending.
    //
    // A false "saved" is worse than a visible error. It is the one state in
    // which a person stops looking.
    if (portal.socket && portal.roomId) {
      return SceneVersionCache.get(portal.socket) === getSceneVersion(elements);
    }
    // No room means nothing to save, so report saved rather than blocking
    // unload. This branch is now reached only when there is genuinely no
    // socket — which is the only case where "nothing to write" is true.
    return true;
  },

  saveToBackend: async (
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ) => {
    const { roomId, roomKey, socket } = portal;

    // `roomKey` is deliberately absent from this guard. A board created since
    // ADR 0012 has none, and requiring one here meant the scene was never
    // written at all — no request, no error, nothing in any log. `Collab.tsx`
    // dropped its own `roomKey` gates for exactly this reason and says so in
    // three places; `getBoardLinkData` dropped the one that stopped `/b/<id>`
    // joining its room (invariant 25). This was the last one standing, and it
    // was the one holding the durable write.
    //
    // The key is still destructured, because the 409 path below passes it to
    // `readElements` to open a *legacy* ciphertext board. Nullable there, and
    // irrelevant to whether we are allowed to save.
    if (!roomId || !socket || lawhaBackend.isSavedToBackend(portal, elements)) {
      return null;
    }

    let payload = elements;
    let expectedRev = RevCache.get(socket);

    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      // Plaintext, and no IV header at all — the server reads its absence as
      // "this body is not encrypted". Writing the scene in the clear is also
      // what converts a legacy board: the first save after this shipped
      // replaces the ciphertext row with a readable one, permanently.
      const body = new TextEncoder().encode(JSON.stringify(payload));

      const response = await fetch(`${API_BASE}/boards/${roomId}/scene`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          ...NGROK_SKIP_HEADER,
          "Content-Type": "application/octet-stream",
          [SCENE_HEADERS.EXPECTED_REV]:
            expectedRev === null ? "" : String(expectedRev),
          [SCENE_HEADERS.SCENE_VERSION]: String(getSceneVersion(payload)),
        },
        body,
      });

      // A 200 with no `x-lawha-rev` header is not lawha-server answering — it
      // is the same class of impostor response `NGROK_SKIP_HEADER` in
      // `data/api.ts` documents: ngrok's interstitial and an intermediary's
      // own error page can both arrive as a 200 carrying none of this
      // endpoint's headers. `Number(null)` is `0`, a rev that looks exactly
      // like a legitimate first save, so trusting `response.ok` alone here
      // would report "Saved" for an edit that was never written anywhere —
      // and there is no local copy to recover it from, because
      // `LocalData.pauseSave("collaboration")` is active for the whole
      // session (invariant 17). Falling through to the `!== 409` check below
      // is deliberate: a 200 missing this header is treated exactly like any
      // other failed save, not given a branch of its own.
      const rev = response.headers.get(SCENE_HEADERS.REV);

      if (response.ok && rev !== null) {
        RevCache.set(socket, Number(rev));
        SceneVersionCache.set(socket, payload);
        return toBrandedType<RemoteExcalidrawElement[]>(
          payload as unknown as RemoteExcalidrawElement[],
        );
      }

      if (response.status !== 409) {
        throw new Error(`Could not save the board (${response.status}).`);
      }

      // Someone else wrote first. The server does not merge — merging is per
      // element and never deleting, which is `reconcileElements` in the editor
      // — so we read their copy, reconcile locally, and try again. This is
      // what keeps the "reconnect merges, never overwrites" promise.
      const theirs = await parseSceneResponse(response);
      const theirElements = getSyncableElements(
        restoreElements(await readElements(theirs, roomId, roomKey), null),
      );

      payload = getSyncableElements(
        reconcileElements(
          payload,
          theirElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
      expectedRev = theirs.rev;
    }

    throw new Error("Could not save the board after repeated conflicts.");
  },

  /**
   * Reads the stored scene.
   *
   * The two "nothing" answers are different values and callers must keep them
   * apart:
   *
   *  - `null` — the server holds **no `board_scenes` row** for this board. Six
   *    boards in the dev database are in exactly this state: a `boards` row and
   *    no scene, left behind by imports that failed and reported nothing. To
   *    every caller they looked identical to a blank board, which is how the
   *    failure came to present as "this board is empty" rather than as an
   *    error.
   *  - `[]` — the server holds a scene and it decrypts to zero elements. A
   *    genuinely blank board. This is reachable: the write path refuses an
   *    empty *ciphertext*, but `[]` encrypts to plenty of bytes.
   */
  loadFromBackend: async (roomId, roomKey, socket) => {
    const response = await fetch(`${API_BASE}/boards/${roomId}/scene`, {
      credentials: "same-origin",
      headers: { ...NGROK_SKIP_HEADER },
    });

    if (response.status === 404) {
      // Reported rather than returned silently, but deliberately not thrown: a
      // board created a moment ago has no stored scene either, and that is the
      // ordinary first-run case. The caller is the only party that knows which
      // of the two it is looking at — `Collab.startCollaboration` skips this
      // call entirely when it is the one creating the room — so this says
      // exactly what happened and lets it decide.
      console.warn(
        `lawha: the server holds no stored scene for board ${roomId} (404). ` +
          `That is expected for a board that has never been saved, and is also ` +
          `what a half-finished import leaves behind — it is NOT the same as a ` +
          `board whose stored scene is empty, which comes back as [].`,
      );
      return null;
    }
    if (!response.ok) {
      throw new Error(`Could not load the board (${response.status}).`);
    }

    const stored = await parseSceneResponse(response);
    const elements = getSyncableElements(
      restoreElements(await readElements(stored, roomId, roomKey), null, {
        deleteInvisibleElements: true,
      }),
    );

    if (socket) {
      SceneVersionCache.set(socket, elements);
      RevCache.set(socket, stored.rev);
    }

    // Convert on open. A board that was still encrypted has just been read by
    // the one party that could read it, and this is the only moment its
    // plaintext exists anywhere — so write it straight back.
    //
    // This is the *main* conversion path, not a nicety. Measured on the live
    // database before any of this shipped: the server could open only 7 of the
    // 16 live boards that had a stored scene, because 9 had no escrow row it
    // could reach. Their keys are not lost, they are in the IndexedDB of the
    // browser that made them — which is exactly where a server-side sweep
    // cannot look and where this runs.
    //
    // Un-awaited and swallowed on purpose: the caller is opening a board, and
    // a failed rewrite costs nothing but a retry on the next open. Notably it
    // does NOT go through `saveToBackend`, which would refuse — its
    // `isSavedToBackend` short-circuit sees an unchanged sceneVersion and
    // returns early, which is correct for its own job and wrong for this one.
    if (stored.iv.byteLength > 0) {
      void rewriteAsPlaintext(roomId, elements, stored.rev).catch(
        () => undefined,
      );
    }

    return elements;
  },

  saveFilesToBackend: async ({ prefix, files }) => {
    const parsed = parseFilePrefix(prefix);
    if (!parsed) {
      return { savedFiles: [], erroredFiles: files.map(({ id }) => id) };
    }

    const savedFiles: FileId[] = [];
    const erroredFiles: FileId[] = [];

    await Promise.all(
      files.map(async ({ id, buffer }) => {
        try {
          const response = await fetch(
            `${API_BASE}/files/${parsed.scope}/${parsed.containerId}/${id}`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                ...NGROK_SKIP_HEADER,
                "Content-Type": "application/octet-stream",
              },
              body: buffer as BodyInit,
            },
          );
          // The id is a content hash, so an already-present file is a success.
          if (response.ok) {
            savedFiles.push(id);
            return;
          }

          const message = FATAL_UPLOAD_STATUS_MESSAGES[response.status];
          if (message) {
            throw new StorageError(message, response.status);
          }

          erroredFiles.push(id);
        } catch (error) {
          // Rethrow so the rejection reaches Portal's catch; anything else is
          // transient and belongs in erroredFiles for the next attempt.
          if (error instanceof StorageError) {
            throw error;
          }
          erroredFiles.push(id);
        }
      }),
    );

    return { savedFiles, erroredFiles };
  },

  loadFilesFromBackend: async (prefix, decryptionKey, fileIds) => {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();

    const parsed = parseFilePrefix(prefix);
    if (!parsed) {
      for (const id of fileIds) {
        erroredFiles.set(id, true);
      }
      return { loadedFiles, erroredFiles };
    }

    await Promise.all(
      // Dedupe: the same file can be referenced by several elements.
      [...new Set(fileIds)].map(async (id) => {
        try {
          const response = await fetch(
            `${API_BASE}/files/${parsed.scope}/${parsed.containerId}/${id}`,
            {
              credentials: "same-origin",
              headers: { ...NGROK_SKIP_HEADER },
            },
          );

          if (response.status >= 400) {
            erroredFiles.set(id, true);
            return;
          }

          const { data, metadata } = await decodeFile(
            new Uint8Array(await response.arrayBuffer()),
            decryptionKey,
          );

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL: new TextDecoder().decode(data) as DataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } catch (error: any) {
          erroredFiles.set(id, true);
          console.error(error);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  },
};
