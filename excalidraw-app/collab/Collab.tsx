import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, cloneJSON, EVENT, toBrandedType } from "@excalidraw/common";
import {
  COLLABORATOR_PALETTE,
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  THEME,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { onCollaboratorAvatarReady } from "@excalidraw/excalidraw/clients";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import {
  isImageElement,
  isInitializedImageElement,
  StoreIncrement,
} from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { HistoryDelta } from "@excalidraw/excalidraw/history";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  CollaboratorPointer,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FILE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SAVE_TO_BACKEND_INTERVAL_MS,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  FULL_BOARD_ACCESS,
  getBoard,
  openBoardToLink,
  resolveBoardAccess,
  setBoardLinkAccess,
} from "../data/boards";
import { getCurrentBoardId } from "../data/currentBoard";
import { avatarUrl } from "../lawha/auth/authApi";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToBackend,
  loadFilesFromBackend,
  loadFromBackend,
  saveFilesToBackend,
  saveToBackend,
} from "../data/storage";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";
import {
  debounceWithMaxWait,
  deserialiseDelta,
  isEntryApplicable,
  readHistory,
  serialiseDelta,
  writeHistory,
} from "../data/undoHistory";
import { sessionAtom } from "../lawha/auth/useLawhaSession";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import type { BoardAccess, LinkAccess } from "../data/boards";

/** Mirrors SOCKET_ERRORS in lawha-server/src/protocol.ts. */
const SOCKET_ERROR_UNAUTHENTICATED = "LAWHA_UNAUTHENTICATED";
const SOCKET_ERROR_FORBIDDEN = "LAWHA_FORBIDDEN";

/**
 * Codes carried by `lawha-error`; mirrors ROOM_ERRORS in
 * lawha-server/src/socket/rooms.ts.
 *
 * The last two arrive *mid-session*, on a healthy socket, when someone changes
 * this board's sharing while it is open. Access used to be decided once at
 * join time and never revisited.
 */
const ROOM_ERROR_FORBIDDEN = "FORBIDDEN";
const ROOM_ERROR_BAD_ROOM_ID = "BAD_ROOM_ID";
const ROOM_ERROR_VIEW_ONLY = "VIEW_ONLY";
const ROOM_ERROR_CAN_EDIT = "CAN_EDIT";

/**
 * Who each socket in the room is, according to the server.
 *
 * Mirrors SERVER_EVENTS.LAWHA_IDENTITIES and `LawhaIdentity` in
 * lawha-server/src/protocol.ts. It rides alongside `room-user-change` rather
 * than inside it: that event's payload is a bare array of socket ids, which is
 * the client's own vocabulary and must not be widened (invariant 15).
 *
 * Emitted by the server and *not* carried on the pointer payload, which is the
 * security half of the design. Pointer payloads are whatever the sender says
 * they are, so a link guest could have claimed someone else's account id and
 * been rendered with their name and their photograph. The relay already knows
 * each socket's authenticated principal; it is the only party that can say this
 * truthfully.
 */
const LAWHA_IDENTITIES_EVENT = "lawha-identities";

interface LawhaIdentity {
  socketId: string;
  /** null for a link guest, who has no account. */
  userId: string | null;
  username: string;
  colorIndex: number | null;
  /** Only ever set when that account opted in — gated server-side. */
  avatarId: string | null;
  isGuest: boolean;
  canEdit: boolean;
}

/**
 * Placeholder for the room `startCollaboration(null)` has not invented yet.
 *
 * The re-entry guard has to claim the slot *before* the first await, and on
 * that path the room id only exists several awaits later. Not a valid board id,
 * so it can never collide with one.
 */
const ROOM_ID_PENDING = "pending:no-room-id-yet";

/**
 * How long a burst of local edits may settle before the undo stack is
 * written to IndexedDB. `history.record` fires on every durable increment —
 * one per completed action, several a second while dragging a shape by hand
 * — and a write re-walks the whole stack (`capHistory`), so debouncing turns
 * a burst into the one write that matters instead of one per mutation.
 */
const UNDO_HISTORY_WRITE_DEBOUNCE_MS = 1000;

/**
 * The ceiling on that debounce — how long a burst of *uninterrupted* editing
 * may defer the write before one is forced through.
 *
 * Without it the debounce is trailing-only, so somebody sketching at
 * sub-second intervals re-arms the timer on every stroke and never lets it
 * expire; closing the tab then `.cancel()`s the pending write and persists
 * nothing at all. That is precisely the long, absorbed session this feature
 * exists to survive, so the failure was worst exactly where the value was
 * highest.
 *
 * `SAVE_TO_BACKEND_INTERVAL_MS`, deliberately, rather than a number picked
 * for feel. The scene itself is throttled to the server on that interval
 * (`queueSaveToBackend`), and `LocalData.pauseSave("collaboration")` is
 * active for the whole session (invariant 17), so the server copy is the only
 * durable one and the board is at most that far behind at any instant.
 * Matching it means the undo stack is never *more* stale than the scene it
 * describes: a tab closed at an arbitrary moment loses the same window from
 * both, and reopening does not find history that refers to edits the scene
 * never received. A larger value would make undo the weaker of the two; a
 * smaller one would buy durability for entries whose scene had not been saved
 * yet, at the cost of more IndexedDB writes for no reachable benefit.
 */
const UNDO_HISTORY_WRITE_MAX_WAIT_MS = SAVE_TO_BACKEND_INTERVAL_MS;

/** What `startCollaboration` resolves with, and what `initialData` receives. */
type CollabSceneData = ImportedDataState & {
  elements: readonly OrderedExcalidrawElement[];
};

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

/**
 * Whether the user's work has actually reached the server, and when.
 *
 * Reported from the save path rather than inferred from edits: while
 * collaborating, LocalData saving is paused, so the server copy is the only
 * durable one and "saved" has to mean the write completed.
 */
export type SaveStatus = {
  state: "saved" | "saving" | "error";
  /** Timestamp of the last successful save; null before the first one. */
  at: number | null;
};

export const saveStatusAtom = atom<SaveStatus>({ state: "saved", at: null });

/**
 * This client's rights on the open board.
 *
 * Read by App to set `viewModeEnabled` and by the share panel to decide what
 * it may offer. It is a mirror of a server decision, never the decision
 * itself: every path it guards is also refused server-side.
 */
export const boardAccessAtom = atom<BoardAccess>(FULL_BOARD_ACCESS);

/**
 * The board id `boardAccessAtom`'s current value actually describes.
 *
 * `boardAccessAtom` is one global slot with no board id of its own, so on its
 * own a reader cannot tell "board B, freshly resolved" apart from "board A,
 * left over from before board B was ever opened" — both are just a
 * `BoardAccess` sitting in the same atom. `BoardRoute` reads this alongside
 * it and refuses to trust a `canAccess: false` for any board other than the
 * one named here: without that, the very first render of a *different*,
 * fully accessible board inherited whatever the previous board's
 * `refreshBoardAccess` — or `handleAccessRevoked`, mid-session — had left
 * behind, and bounced to `/` before this board's own access check had even
 * started (`refreshBoardAccess` is several awaits deep inside
 * `startCollaboration`, which had not run yet).
 *
 * Written only in `refreshBoardAccess`, the one place that actually learns
 * which board was just resolved. The narrower updates elsewhere —
 * `handleAccessRevoked`, the view/edit toggle in `handleServerError`, the
 * read-only fallback when a legacy scene cannot be decrypted — all describe
 * whatever board this atom already names, so none of them need to touch it.
 */
export const boardAccessBoardIdAtom = atom<string | null>(null);

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
  /** Chosen cursor colour; null falls back to the hash of the user id. */
  colorIndex: number | null;
  /** Chosen laser colour; null follows colorIndex. */
  laserColorIndex: number | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  /** Closes the board's link. Does not end the session or touch the scene. */
  stopSharing: CollabInstance["stopSharing"];
  setLinkAccess: CollabInstance["setLinkAccess"];
  refreshBoardAccess: CollabInstance["refreshBoardAccess"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromBackend: CollabInstance["fetchImageFilesFromBackend"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  setPaletteChoices: CollabInstance["setPaletteChoices"];
  /** Re-resolves every peer's laser colour after a local theme change. */
  resolveAllPointerColors: CollabInstance["resolveAllPointerColors"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();
  /**
   * The last identity the *server* announced for each socket.
   *
   * Kept alongside the collaborator map rather than inside it, because that map
   * is also written by pointer and idle payloads — which the *sender* composes.
   * `username` appears in both, and `updateCollaborator` merges with
   * `Object.assign`, so the later write wins: a peer's own pointer packet,
   * arriving every 33ms, overwrote the name the server had assigned them.
   *
   * That is not theoretical. A link guest has no session, so the effect that
   * seeds `setUsername` from the account never runs and the client falls back
   * to `getRandomUsername()`, while the server names them "Guest <something>".
   * Every peer watched the name flip on the guest's first mouse move. The same
   * path is what a modified client would use to broadcast somebody else's name,
   * which is precisely what announcing identity from the server was meant to
   * prevent.
   */
  private serverIdentities = new Map<SocketId, LawhaIdentity>();
  /** The last scene this saw. Only `leaveRoom` reads it — see the note there. */
  private lastSyncedElements: readonly OrderedExcalidrawElement[] = [];

  /**
   * Unsubscribes this room's undo-history listener (see `writeUndoHistory`).
   *
   * Not tied to unmount: the "start collaborating" button calls
   * `startCollaboration` again on an already-mounted instance after
   * `stopCollaboration`, and each call subscribes afresh. Torn down in
   * `destroySocketClient` — the funnel every way out of a room already runs
   * through — rather than only in `leaveRoom`, so a stop/start cycle can
   * never leave a second, stale listener debouncing writes alongside the
   * live one.
   */
  private unsubscribeUndoHistoryIncrement: (() => void) | null = null;

  /**
   * True from the first line of `componentWillUnmount` until the next
   * `componentDidMount`.
   *
   * Boards are routes, so this component genuinely unmounts — and everything
   * asynchronous it had already started keeps running. `startCollaboration`
   * alone awaits board access and a dynamic import before it touches a socket,
   * so an instance that unmounts inside that window goes on to open a
   * connection with no unload listeners left to close it: immortal for the
   * life of the tab, and broadcasting the empty scene of an editor that no
   * longer exists.
   *
   * The initializer here is *not* the whole story, and reading it as such is
   * what broke development. React 19's StrictMode double invoke calls
   * `componentWillUnmount` and then `componentDidMount` on the same instance
   * (`disappearLayoutEffects` / `reappearLayoutEffects`, both against
   * `finishedWork.stateNode`), and a field initializer runs once, at
   * construction. So this line never ran again, the flag stayed true, and
   * `startCollaboration` refused for the life of the tab — every board opening
   * local-only in `yarn dev`, silently. `componentDidMount` puts it back.
   */
  private isUnmounted = false;

  /**
   * The exact `CollabAPI` object published to `collabAPIAtom` on mount.
   *
   * Held so unmount can clear the atom *by identity*. React may commit the next
   * board's Collab before this one's unmount runs, and an unconditional clear
   * would then take the live API away with it.
   */
  private publishedCollabAPI: CollabAPI | null = null;

  /**
   * The room this instance has committed to opening, claimed synchronously at
   * the top of `startCollaboration`. See the guard there for why the old check
   * — `if (this.portal.socket)` — could not do this job.
   */
  private joiningRoomId: string | null = null;

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
      colorIndex: null,
      laserColorIndex: null,
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      // Both halves gate on `roomId` alone now. `roomKey` was part of the
      // condition when every file was encrypted with it; a board created since
      // ADR 0012 has no key, and keeping it here would abort every image
      // upload and fetch on every current board.
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId) {
          throw new AbortError();
        }

        return loadFilesFromBackend(
          `${FILE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          roomKey,
          fileIds,
        );
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId } = this.portal;
        if (!roomId) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToBackend({
          prefix: `${FILE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    // Mounted, therefore not unmounted — stated here rather than left to the
    // field initializer, because this method can run on an instance that has
    // already been through `componentWillUnmount`.
    //
    // That is not a rare case, it is what `yarn dev` does on every load:
    // React 19's StrictMode double invoke tears the layout effects down and
    // brings them back up on the *same* instance, so the sequence a mount
    // actually sees is didMount, willUnmount, didMount. A field initializer
    // runs once, at construction, and cannot answer that.
    //
    // Only this flag is reset. `joiningRoomId` deliberately is not: an
    // in-flight `startCollaboration` from before the double invoke resumes
    // after it and carries on to open its socket, and the claim it is still
    // holding is precisely what refuses the second call the remount triggers.
    // Clearing that too would let both through and put two sockets in the room.
    this.isUnmounted = false;

    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );

    // A decoded avatar has to provoke a repaint, because the interactive canvas
    // is not on a continuous render loop: a peer who is idle when their picture
    // finishes decoding would otherwise keep their crewmate until they next
    // moved the mouse. That is the objection ADR 0003 raised against canvas
    // avatars, and this is the answer to it — one repaint per decoded image,
    // none afterwards, because the second frame hits the cache.
    const unsubOnAvatarReady = onCollaboratorAvatarReady(() =>
      this.republishCollaborators(),
    );

    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
      unsubOnAvatarReady();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromBackend: this.fetchImageFilesFromBackend,
      stopCollaboration: this.stopCollaboration,
      stopSharing: this.stopSharing,
      setLinkAccess: this.setLinkAccess,
      refreshBoardAccess: this.refreshBoardAccess,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      setPaletteChoices: this.setPaletteChoices,
      resolveAllPointerColors: this.resolveAllPointerColors,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
    };

    this.publishedCollabAPI = collabAPI;
    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    // First, before anything that can yield: every asynchronous thing this
    // instance started reads it to decide whether it is still allowed to act.
    this.isUnmounted = true;

    // Withdrawing the API is not tidying up, it is the fix for a board that
    // opens empty.
    //
    // `App`'s boot effect depends on both `collabAPI` and `excalidrawAPI`. The
    // editor API is published from a context that lives above the router, so on
    // the next board it updates a render *before* the new Collab publishes
    // itself — and with a dead instance still sitting in this atom, that effect
    // runs `initializeScene` against it. The dead instance then opens a socket
    // that nothing will ever close (its unload listeners were removed a few
    // lines below), the relay stops treating the real client as first-in-room
    // because the room is no longer empty, and the zombie answers the real
    // client's arrival with a SCENE_INIT carrying the empty scene of an editor
    // that has already torn down. Eighteen bytes of `[]` beat a live peer's
    // tens of kilobytes every time.
    //
    // Cleared by identity: React may commit the next board's Collab before this
    // unmount runs, and a blind `set(null)` would then take the live API away.
    if (
      this.publishedCollabAPI &&
      appJotaiStore.get(collabAPIAtom) === this.publishedCollabAPI
    ) {
      appJotaiStore.set(collabAPIAtom, null);
    }
    this.publishedCollabAPI = null;

    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    // `initializeIdleDetector` below adds these two on `document`, not
    // `window` — `removeEventListener` on a target the listener was never
    // added to is a silent no-op, neither an error nor a warning, so this
    // pair used to leave both listeners (and the dead `Collab` instance and
    // its idle timers they close over, via `this.onPointerMove` and
    // `this.onVisibilityChange`) attached for the life of the tab. Boards are
    // routes and this component genuinely unmounts on every navigation
    // between them, so that was two leaked document-level listeners per
    // board visited, not a one-off.
    document.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    // Also cleared by `destroySocketClient`, which is where every ordinary
    // teardown reaches it. Repeated here because `leaveRoom` below is
    // conditional on there being a socket, and a timer that survives an unmount
    // is the one that has nothing left to check it.
    this.clearSocketInitializationTimer();

    if (this.portal.socket) {
      this.leaveRoom();
    }

    this.onUmmount?.();
  }

  /**
   * Leaves the room on unmount.
   *
   * Upstream never needed this: the canvas was the only page, so this component
   * lived as long as the document. Boards are routes now, and an open socket
   * would keep the user counted as editing a board they walked away from, then
   * add a second socket the moment they opened another one.
   *
   * Deliberately *not* `stopCollaboration`. That reads the scene back out of
   * the editor to flush it — but by the time `componentWillUnmount` runs, the
   * editor above has already torn down and hands back an empty scene, which is
   * then written over the board. The last write wins and the work is gone; it
   * cost a board in testing before this was split out. So the flush uses the
   * last elements that went past `syncElements`, and the only fresh read is of
   * something that cannot be empty by accident.
   */
  private leaveRoom = () => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToBackend.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    if (this.lastSyncedElements.length) {
      // Before `destroySocketClient`, which closes the portal: `saveToBackend`
      // reads the room id and key off it synchronously.
      void this.saveCollabRoomToBackend(
        getSyncableElements(this.lastSyncedElements),
      );
    }

    this.removeConnectErrorHandler();

    LocalData.fileStorage.reset();
    this.destroySocketClient();
  };

  /**
   * Detaches the `connect_error` listener, by the identity it was registered
   * with.
   *
   * All three of these call sites used to pass `this.fallbackInitializationHandler`,
   * which was never the registered listener: the listener is an anonymous arrow
   * that inspects the error first and only *calls* the fallback. `socket.off`
   * matches by identity, so it removed nothing and a fetch-and-discard stayed
   * armed for the whole session — every reconnect attempt pulled the scene from
   * storage and threw it away, on a room the user may already have left.
   */
  private removeConnectErrorHandler = () => {
    if (this.portal.socket && this.connectErrorHandler) {
      this.portal.socket.off("connect_error", this.connectErrorHandler);
    }
    this.connectErrorHandler = null;
  };

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToBackend(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToBackend(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoomToBackend = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    // A viewer's write is refused server-side, correctly — but attempting it
    // anyway and surfacing the 403 told them "Couldn't save to the backend
    // database", which reads as a fault in the product rather than as the
    // access level they were given. There is nothing to save and nothing has
    // gone wrong, so do not ask.
    //
    // Guarded here rather than at the call sites because this is the funnel:
    // the throttled save, the unmount flush and `beforeunload` all arrive
    // through it. The server check remains the real one; this only stops the
    // client from asking a question it already knows the answer to.
    if (!appJotaiStore.get(boardAccessAtom).canEdit) {
      return;
    }

    syncableElements = cloneJSON(syncableElements);

    const previousStatus = appJotaiStore.get(saveStatusAtom);
    appJotaiStore.set(saveStatusAtom, {
      state: "saving",
      at: previousStatus.at,
    });

    try {
      const storedElements = await saveToBackend(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();
      appJotaiStore.set(saveStatusAtom, { state: "saved", at: Date.now() });

      if (this.isCollaborating() && storedElements) {
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
      }
    } catch (error: any) {
      appJotaiStore.set(saveStatusAtom, {
        state: "error",
        at: previousStatus.at,
      });

      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      this.notifyOnce(errorMessage);

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  /**
   * Ends the live session and keeps the board here, local-only.
   *
   * The confirmation that used to live in the middle of this — a
   * `window.confirm` — is gone. A native dialog blocks the renderer's main
   * thread until it is dismissed (invariant 19), and it also conflated two
   * different things: *stop sharing this board* and *stop collaborating on
   * it*. Sharing is now `stopSharing` below; the confirmation, where one is
   * still wanted, is in-app UI in the share panel.
   */
  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToBackend.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToBackend(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    this.removeConnectErrorHandler();

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
      return;
    }

    // hack to ensure that we prefer we disregard any new browser state
    // that could have been saved in other tabs while we were collaborating
    resetBrowserStateVersions();

    // Drop the key fragment but keep the path: ending a session should leave
    // the user on the same board, now local-only, rather than navigating
    // them away from it.
    window.history.pushState(
      {},
      APP_NAME,
      `${window.location.origin}${window.location.pathname}`,
    );
    this.destroySocketClient();

    LocalData.fileStorage.reset();

    const elements = this.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });

    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  /**
   * Closes the board's link without touching the session.
   *
   * Explicitly *not* routed through `stopCollaboration`: that reads the whole
   * scene back out of the editor to flush it, which is the read that cost a
   * board once already (invariant 20), and there is no reason to write the
   * scene at all in order to change one column. Anyone who was here on the
   * link alone is evicted by the server, which re-checks every socket in the
   * room; anyone with a named role stays, which is the point of having roles.
   */
  stopSharing = async (): Promise<boolean> => {
    const boardId = this.portal.roomId ?? getCurrentBoardId();
    if (!boardId) {
      return false;
    }

    const board = await setBoardLinkAccess(boardId, "none");
    await this.refreshBoardAccess(boardId);
    return board !== null;
  };

  /**
   * The owner's one choice, carried as the two fields it is stored in.
   *
   * `guestEdit` is not optional here on purpose: every caller has just read a
   * radio option that knows both halves, and a default would let a future call
   * site set "can edit" while silently leaving the wider flag as it was.
   */
  setLinkAccess = async (
    linkAccess: LinkAccess,
    guestEdit: boolean,
  ): Promise<boolean> => {
    const boardId = this.portal.roomId ?? getCurrentBoardId();
    if (!boardId) {
      return false;
    }

    const board = await setBoardLinkAccess(boardId, linkAccess, guestEdit);
    await this.refreshBoardAccess(boardId);
    return board !== null;
  };

  /** Re-reads this client's rights and publishes them for the UI. */
  refreshBoardAccess = async (
    boardId = this.portal.roomId ?? getCurrentBoardId(),
  ): Promise<BoardAccess> => {
    if (!boardId) {
      return FULL_BOARD_ACCESS;
    }
    const access = await resolveBoardAccess(boardId);
    appJotaiStore.set(boardAccessAtom, access);
    // Stamped together with the value above, always — see
    // `boardAccessBoardIdAtom`'s own doc for why a reader needs both.
    appJotaiStore.set(boardAccessBoardIdAtom, boardId);
    return access;
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    // Released here and only here, so that the claim taken at the top of
    // `startCollaboration` covers the whole join — including the awaits before
    // a socket exists, which is the window the old socket-shaped guard missed.
    this.joiningRoomId = null;
    // Every way out of a room funnels through here — `leaveRoom`,
    // `stopCollaboration` on both of its branches, `handleAccessRevoked` and
    // `onUnload` — which is why the disarm lives here rather than being copied
    // into each of them. It used to be cleared in exactly one place,
    // `markRoomInitialized`, so a room torn down before it ever initialised
    // left a five-second fuse burning. `this.portal` is constructed once and
    // reused, so that fuse wakes up holding the *next* room's socket.
    this.clearSocketInitializationTimer();
    this.portal.close();
    this.fileManager.reset();
    // `.cancel()`, never `.flush()`. The reason is the *room*, not invariant
    // 20: an earlier version of this comment claimed invariant 20, and that
    // over-applied it — the pending write reads `getUndoStack()`, which is
    // the history stack, not the scene, so flushing it would not commit an
    // emptied editor back over the board the way a scene read during teardown
    // would. What it would do is write board A's stack under whichever room
    // `this.portal.roomId` has become, and `startCollaboration` can re-point
    // that at board B inside the same debounce window (pinned by "does not
    // write the old room's stack under the new room's key"). Placed on every
    // path out of a room, not only `leaveRoom`, for the same reason the
    // listener it pairs with is torn down here — see
    // `unsubscribeUndoHistoryIncrement`'s doc.
    //
    // Cancelling is affordable only because the debounce has a ceiling
    // (`UNDO_HISTORY_WRITE_MAX_WAIT_MS`): what a cancel discards is at most
    // that window's worth of stack, never the whole session's.
    this.writeUndoHistory.cancel();
    this.unsubscribeUndoHistoryIncrement?.();
    this.unsubscribeUndoHistoryIncrement = null;
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      // Dropped with the collaborators it describes. Socket ids are not reused
      // across rooms, but a stale identity outliving its session is a name
      // waiting to be applied to whoever lands on that key next.
      this.serverIdentities = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  /**
   * Shows an error once per session rather than once per occurrence.
   *
   * Both callers fire from inside a loop the user is not driving: a save
   * retried on a timer, and a decrypt attempted on every inbound message.
   * Repeating the same sentence is not more informative, and one of these runs
   * at cursor frequency.
   *
   * Outside a live session the guard lifts — a one-off failure the user
   * provoked themselves should say so every time, because there is no stream
   * behind it to turn the message into noise.
   */
  private notifyOnce = (message: string) => {
    if (this.state.dialogNotifiedErrors[message] && this.isCollaborating()) {
      return;
    }

    this.setErrorDialog(message);
    this.setState({
      dialogNotifiedErrors: {
        ...this.state.dialogNotifiedErrors,
        [message]: true,
      },
    });
  };

  private fetchImageFilesFromBackend = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  /**
   * Reads one relayed message, encrypted or not.
   *
   * **A zero-length iv means the payload is plaintext JSON** — the same
   * convention the stored scene uses, and the reason the relay needed no change
   * at all. The legacy branch exists for one narrow window: a peer still
   * running the previous build, in a room with a peer running this one, during
   * a deploy. It goes when that window closes.
   */
  private parsePayload = async (
    iv: Uint8Array<ArrayBuffer>,
    data: ArrayBuffer,
    decryptionKey: string | null,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      if (iv.byteLength === 0) {
        return JSON.parse(
          new TextDecoder("utf-8").decode(new Uint8Array(data)),
        );
      }

      if (!decryptionKey) {
        throw new Error(
          "lawha: an encrypted broadcast arrived and this board has no key",
        );
      }

      const decrypted = await decryptData(iv, data, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      // The last native dialog in the app, and upstream's. Two reasons it had
      // to go: `window.alert` blocks the renderer's main thread until it is
      // dismissed (invariant 19, and the exact failure that once read as a
      // frozen tab), and this runs per *message* — the cursor stream alone is
      // ~30 a second, so a peer with the wrong key would have queued one alert
      // per packet. The blocking was accidentally throttling the spam.
      //
      // Reported once per session instead, through the same guard the save
      // path uses. A board whose key does not match is wrong from the first
      // message; saying so a thousand times adds nothing.
      this.notifyOnce(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  /**
   * The function actually handed to `socket.on("connect_error", ...)`.
   *
   * Held separately from the fallback it wraps, because `socket.off` matches by
   * identity. See `removeConnectErrorHandler`.
   */
  private connectErrorHandler: null | ((error: Error) => void) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string | null },
  ) => {
    // Refused before anything else can yield. Past `componentWillUnmount` this
    // instance has no editor above it and no unload listeners left, so any
    // socket it opened here would outlive every mechanism that could close it.
    if (this.isUnmounted) {
      return null;
    }

    // The line that actually refuses a second client for the same board — and
    // the one whose absence made a board with content open empty.
    //
    // It used to read `if (this.portal.socket) return null`, which is wrong in
    // two independent ways. It is shaped like the *socket* rather than like the
    // *room*, so an unmounted instance whose socket `leaveRoom` had just closed
    // sailed straight through it and opened another one. And it is not
    // synchronous with respect to what it guards: `this.portal.socket` is not
    // assigned until board access has been resolved and socket.io-client has
    // been imported, several awaits later, so two calls in the same tick both
    // passed and the second orphaned the first's connection.
    //
    // Invariant 21 is the general form of this: the check that looks like it is
    // enforcing something, and the check that is, need not be the same one.
    if (this.joiningRoomId !== null) {
      return null;
    }
    this.joiningRoomId = existingRoomLinkData?.roomId ?? ROOM_ID_PENDING;

    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    let roomId;
    let roomKey: string | null;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);

      // Before the socket, on purpose. Two things depend on it:
      //
      //  - a visitor with no account has no identity until the server mints a
      //    board-scoped guest pass here, and the handshake would refuse them
      //    outright without one;
      //  - a viewer has to know they are a viewer *before* the editor accepts
      //    an edit. Learning afterwards means the relay has been dropping
      //    their work while they drew.
      await this.refreshBoardAccess(roomId);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());

      // Create the board and open it to link holders *before* the socket
      // connects. Otherwise the board row is only created implicitly by the
      // first scene write, with link access closed, and every peer following
      // the link is refused at join-room — a session that looks live to its
      // host and is unreachable for everyone else.
      await openBoardToLink(roomId);
      await this.refreshBoardAccess(roomId);

      // The claim above was taken before this id existed. Narrow it now that it
      // does, so the guard reads as "this room" rather than "some room".
      this.joiningRoomId = roomId;

      window.history.pushState({}, APP_NAME, getCollaborationLink({ roomId }));
    }

    // The board route can be left while board access is in flight. Nothing
    // downstream would notice: `componentWillUnmount` has already run and will
    // not run again, so the socket opened below would never be closed.
    if (this.isUnmounted) {
      this.joiningRoomId = null;
      return null;
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<CollabSceneData | null>();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

    // Second unmount check, because the import above is the longest await on
    // this path — a chunk fetched over the network on a cold load.
    if (this.isUnmounted) {
      this.destroySocketClient();
      return null;
    }

    /**
     * Nobody answered, so stop waiting for them.
     *
     * Fires on the initial-scene timeout and on a transport-level failure.
     * Whatever storage has — including nothing — is the answer at that point,
     * so it resolves the editor's one-shot `initialData` rather than leaving it
     * pending forever.
     *
     * It loads again rather than reusing the load started when the socket
     * opened, and that is the point on both of its paths: a `connect_error` and
     * a five-second silence are the two situations in which the first attempt
     * is most likely to have failed. A second GET is cheap; `initialData` stuck
     * on "Loading scene…" is not. If the first load already delivered, both
     * `scenePromise.resolve` calls here are noops.
     */
    const fallbackInitializationHandler = () => {
      // Armed for *this* room, so refuse to run for any other one.
      //
      // Both of the ways in here outlive the room they were set up for: the
      // timer below survives whatever tore the socket down, and `connect_error`
      // fires on socket.io's own retry schedule. `this.portal` is constructed
      // once and reused across rooms on one instance — which the landing route
      // does routinely, since only `/b/:boardId` is keyed by board — so "the
      // portal still has a socket" is not the same question as "the portal is
      // still on my room". Running anyway would stand down the *current* room's
      // fallback and then load the *previous* room's scene onto its canvas.
      if (this.portal.roomId !== roomId) {
        return;
      }

      this.markRoomInitialized();
      void this.loadSceneFromServer(existingRoomLinkData, scenePromise).then(
        (scene) => {
          scenePromise.resolve(scene);
        },
      );
    };

    try {
      this.portal.socket = this.portal.open(
        socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          // Carries the session cookie. Harmless same-origin, required if the
          // server is ever deployed on a separate host.
          withCredentials: true,
        }),
        roomId,
        roomKey,
      );

      // Put the board's own name on the title, now that `portal.roomId` is set
      // for `syncBoardName` to check itself against. Not awaited: the title is
      // chrome, and blocking the join on it would make a slow metadata call
      // delay the scene.
      void this.syncBoardName(roomId, scenePromise);

      // `.on`, not `.once`: socket.io retries, so a second failure would
      // otherwise go unhandled entirely.
      //
      // Kept in a field, because `socket.off` matches listeners by identity and
      // this arrow — not the fallback it calls — is what was registered.
      this.connectErrorHandler = (error: Error) => {
        if (error.message === SOCKET_ERROR_UNAUTHENTICATED) {
          // Falling back to storage here would only 401 as well, leaving the
          // user staring at an empty canvas with no explanation.
          this.setErrorDialog(t("errors.collabAuthRequired"));
          return;
        }
        if (error.message === SOCKET_ERROR_FORBIDDEN) {
          this.setErrorDialog(t("errors.collabForbidden"));
          return;
        }
        fallbackInitializationHandler();
      };
      this.portal.socket.on("connect_error", this.connectErrorHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      // Released, or this instance could never try again: the claim is what
      // the re-entry guard reads, and nothing else clears it on this path.
      this.joiningRoomId = null;
      return null;
    }

    if (existingRoomLinkData) {
      // when joining existing room, don't merge it with current scene data
      this.excalidrawAPI.resetScene();
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToBackend(getSyncableElements(elements));
    }

    // The board's own copy, always, and never a peer's.
    //
    // Started here, unconditionally, rather than only on `first-in-room`. The
    // server sends that event only when the room is empty
    // (lawha-server/src/socket/rooms.ts), so a client that arrives second used
    // to learn its own board *exclusively* from another client's SCENE_INIT —
    // and a peer with nothing to give (a second tab, a stale client, an editor
    // that has already torn down) answers with `[]`. Invariant 17 says why that
    // is the wrong shape even when it works: local saving is paused for the
    // whole session, so the server copy is the only durable one, and a client
    // must never depend on another client to be told what its own board holds.
    //
    // Started *after* the `resetScene` above and before any listener is
    // registered, so the ordering is unambiguous in both directions: the reset
    // can never land on a loaded scene, and no handler can read this binding
    // before it exists.
    //
    // Skipped only when this call is *creating* the room: an id generated
    // milliseconds ago cannot have a stored scene, and asking would log a
    // missing-scene warning for every new board.
    const storedScene = this.loadSceneFromServer(
      existingRoomLinkData,
      scenePromise,
    );

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        // The `if (!roomKey) return` that used to stand here is gone. A board
        // created since ADR 0012 has no key at all, so that guard would have
        // dropped every message on every current board — silently, which is
        // the failure mode this codebase keeps rediscovering.
        const decryptedData = await this.parsePayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (!this.portal.socketInitialized) {
              const remoteElements = toBrandedType<
                readonly RemoteExcalidrawElement[]
              >(decryptedData.payload.elements ?? []);

              // A SCENE_INIT carrying nothing is not an answer, and must not be
              // allowed to stand down the storage fallback or resolve the
              // editor's one-shot `initialData` on its own.
              //
              // This is defence in depth for the zombie-Collab bug: an INIT of
              // `[]` is eighteen bytes and arrives before any real peer's tens
              // of kilobytes, so whichever client has *nothing* wins the race.
              // It is also the honest reading on its own terms — a peer with an
              // empty scene has told us nothing about the board, and invariant
              // 17 says the durable copy is the server's, not theirs.
              //
              // It is still *evidence*, though: it says nobody is going to send
              // us anything. So it resolves `initialData` as soon as our own
              // storage read agrees there is nothing, and not before. Without
              // that, an honestly empty board with a second tab open would sit
              // on "Loading scene…" for the full five-second fallback.
              //
              // The flag is still set, because invariant 4: `socketInitialized`
              // gates sending as well as accepting, so leaving it false in
              // order to "keep listening" would silence this client instead.
              // The fallback timer is left armed on purpose — it is what pulls
              // the scene from storage when nobody has anything to give.
              if (remoteElements.length === 0) {
                this.portal.socketInitialized = true;
                void storedScene.then((scene) => {
                  if (scene === null) {
                    scenePromise.resolve(null);
                  }
                });
                break;
              }

              this.markRoomInitialized();
              const reconciledElements =
                this._reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from the storage backend
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
              break;
            }

            // Already initialized — and this used to fall straight out, which
            // lost work on every reconnect.
            //
            // A rejoin makes the relay send `new-user` to everyone already in
            // the room, and each of them answers with a full SCENE_INIT. But
            // `handleReconnect` sets `socketInitialized` back to true after an
            // *awaited* HTTP read of the server copy, so any peer INIT that
            // lands after that await hit this branch and was discarded — with
            // no fallback, and nothing anywhere saying so. Whatever those peers
            // drew during the outage existed only in their tabs.
            //
            // Treating it as an UPDATE is safe rather than merely convenient:
            // reconciliation is per element and never deletes (invariant 2), so
            // a full scene from a peer can add and advance elements but cannot
            // take any away. It does *not* touch `scenePromise` or the scroll —
            // the editor is already up, and re-resolving a one-shot promise or
            // yanking the viewport under someone mid-stroke would be a second
            // bug wearing the first one's clothes.
            this.handleRemoteSceneUpdate(
              this._reconcileElements(
                toBrandedType<readonly RemoteExcalidrawElement[]>(
                  decryptedData.payload.elements ?? [],
                ),
              ),
            );
            break;
          }
          case WS_SUBTYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this._reconcileElements(
                toBrandedType<readonly RemoteExcalidrawElement[]>(
                  decryptedData.payload.elements,
                ),
              ),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer: this.resolvePointerColors(pointer, socketId),
              button,
              selectedElementIds,
              username,
              colorIndex: pointer?.colorIndex ?? null,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const appState = this.excalidrawAPI.getAppState();

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (appState.userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (
              appState.userToFollow &&
              appState.followedBy.has(appState.userToFollow.socketId)
            ) {
              return;
            }

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fit: "contain",
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    // Server-authoritative identity. Registered here rather than in Portal
    // because it writes the collaborator map, which is Collab's to own; Portal
    // relays `room-user-change` into `setCollaborators` and nothing else.
    this.portal.socket.on(
      LAWHA_IDENTITIES_EVENT,
      (identities: LawhaIdentity[]) => {
        this.handleIdentities(identities);
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      // Alone in the room, so nothing will ever send a SCENE_INIT and the
      // editor's one-shot `initialData` has to be resolved from storage —
      // including with `null`, which is how an empty board stops "Loading
      // scene…". Awaited rather than re-fetched: the load above already
      // started when the socket opened.
      this.markRoomInitialized();
      scenePromise.resolve(await storedScene);
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.excalidrawAPI.updateScene({
          appState: { followedBy: new Set(followedBy) },
        });

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    this.initializeIdleDetector();

    // Built from the room rather than read off the address bar, so the link is
    // the canonical `/b/<id>` whichever way the board was reached — including
    // from an old link that still carries a `#key=` fragment we no longer mint.
    this.setActiveRoomLink(getCollaborationLink({ roomId }));

    // Restored once the scene it is checked against is the board's own — see
    // the method's own doc for why that means waiting on `scenePromise`
    // rather than running here directly.
    void this.restoreUndoHistory(roomId, scenePromise);

    // `StoreIncrement.isDurable` is the same signal `App` itself acts on to
    // decide what reaches `history.record`
    // (`store.onDurableIncrementEmitter`, packages/excalidraw/components/App.tsx):
    // an ephemeral increment — a drag preview, anything dispatched
    // `EVENTUALLY` — and a remote update, always dispatched `NEVER`, never
    // move the undo stack, so debouncing a write on either would just be
    // debouncing against noise the stack never actually gained.
    this.unsubscribeUndoHistoryIncrement = this.excalidrawAPI.onIncrement(
      (increment) => {
        if (StoreIncrement.isDurable(increment)) {
          this.writeUndoHistory();
        }
      },
    );

    return scenePromise;
  };

  /**
   * Marks the socket ready to send, and stands the storage fallback down.
   *
   * Split out of what used to be `initializeRoom`, which did this *and*
   * fetched the scene *and* reset the canvas before fetching it. Those are
   * three separate decisions and only this one is safe to make on a peer's
   * say-so — which is exactly how an empty SCENE_INIT from an unmounted client
   * came to cancel the fallback that would have loaded the real board.
   */
  private markRoomInitialized = () => {
    this.clearSocketInitializationTimer();
    this.removeConnectErrorHandler();
    this.portal.socketInitialized = true;
  };

  /**
   * Disarms the initial-scene fallback, and forgets the handle.
   *
   * Forgetting it is the half that matters. `clearTimeout` on a stale handle is
   * harmless, but leaving the field set means the *next* room's
   * `markRoomInitialized` cannot tell whether it is standing down its own timer
   * or one belonging to a room that is already gone.
   *
   * Note what this deliberately does not touch: `Portal.socketInitialized`.
   * Invariant 4 — that flag gates sending as well as accepting SCENE_INIT, so
   * clearing it to tidy up would silence the client. Teardown resets it through
   * `Portal.close()`, which is the only place that should.
   */
  private clearSocketInitializationTimer = () => {
    if (this.socketInitializationTimer !== undefined) {
      window.clearTimeout(this.socketInitializationTimer);
      this.socketInitializationTimer = undefined;
    }
  };

  /**
   * Loads the open board from the server and puts it on the canvas.
   *
   * Delivered **twice**, on purpose, because the two channels win in opposite
   * orders and neither is sufficient alone:
   *
   *  - `handleRemoteSceneUpdate` is the live path, the same one
   *    `handleReconnect` uses. It works once the editor has consumed its
   *    `initialData`, and is silently discarded if it lands before that:
   *    `App.initializeScene` in packages/excalidraw ends in a `syncActionResult`
   *    that replaces the *whole* element set with whatever the promise gave it.
   *  - `scenePromise` is that one-shot `initialData`. It works when the load
   *    finishes first, and can do nothing at all once something else has
   *    resolved it.
   *
   * Both are idempotent, so doing both is free and neither ordering can lose
   * the board.
   *
   * What this deliberately does **not** do is reset the scene first. The old
   * `initializeRoom` did, and that is a board-wiping bug waiting for a bad day:
   * the reset is synchronous, the load is not, and `loadFromBackend` primes the
   * RevCache — so any path out of the load that fails to reach `updateScene`
   * leaves an empty canvas plus a compare-and-swap token that will happily
   * persist the emptiness on the next save (invariant 20's neighbour).
   *
   * @returns the scene to hand to `initialData`, or null when the server has
   * nothing for this board. Never `{ elements: [] }`: an empty result is not
   * something to write over anything.
   */
  private loadSceneFromServer = async (
    roomLinkData: { roomId: string; roomKey: string | null } | null,
    scenePromise: ResolvablePromise<CollabSceneData | null>,
  ): Promise<CollabSceneData | null> => {
    const socket = this.portal.socket;

    // Room-shaped as well as socket-shaped, and checked *before* the fetch.
    //
    // The socket comparison below is the one that catches the room changing
    // during the await, and it does that job. It cannot catch a call that
    // starts after the room has already changed — by then `this.portal.socket`
    // and the socket captured on the line above are the same object, the new
    // room's. Only the id says otherwise.
    //
    // Before the fetch rather than after it because `loadFromBackend` is not
    // read-only from this client's point of view: it primes `RevCache` and
    // `SceneVersionCache`, both keyed by *socket*. Fetching room A over room
    // B's socket would leave room B holding room A's compare-and-swap token,
    // and the next save would spend it — invariant 2's whole point is that the
    // rev is the thing that must never be wrong.
    if (
      !roomLinkData ||
      !socket ||
      this.portal.roomId !== roomLinkData.roomId ||
      this.isUnmounted
    ) {
      return null;
    }

    let elements: readonly OrderedExcalidrawElement[] | null = null;

    try {
      elements = await loadFromBackend(
        roomLinkData.roomId,
        roomLinkData.roomKey,
        socket,
      );
    } catch (error: any) {
      // Surfaced, not swallowed. The comment that used to sit on this catch
      // read "log the error and move on. other peers will sync us the scene" —
      // but this runs precisely when there may be no peers, and when there are,
      // their copy is not the durable one (invariant 17). An unreported failure
      // here is a blank board with no explanation, which is the whole failure
      // mode this change exists to remove: silence is the bug.
      console.error("lawha: could not load this board from the server", error);

      /*
       * **And the board goes read-only, which is the part that matters.**
       *
       * Telling somebody the load failed and then handing them a writable
       * blank canvas is worse than not telling them: the scene they cannot
       * see is still on the server, `queueSaveToBackend` fires on the first
       * stray pointer movement, and a board that was merely unreadable
       * becomes an empty one. That is unrecoverable — the ciphertext it
       * overwrites is the only copy.
       *
       * This is a live risk rather than a theoretical one. Nine boards on this
       * deployment are still stored encrypted with keys the server cannot
       * reach (ADR 0012), including a 12 KB one its owner named "Do not touch
       * copy". Opening any of them in a browser without the key lands here.
       *
       * `canEdit: false` rather than a new flag, deliberately: it is the same
       * lever a viewer and a link guest already go through, so it blocks the
       * scene write in `saveToBackend` AND puts the editor in view mode via
       * `viewModeEnabled` in App.tsx. Inventing a second mechanism beside it
       * is exactly what invariant 21 warns about — a permission enforced in
       * one layer is not enforced.
       *
       * `canAccess` stays true. Access is not the problem and flipping it
       * would bounce them to the dashboard, which reads as "this board is
       * gone" about a board that is merely unreadable here.
       */
      appJotaiStore.set(boardAccessAtom, {
        ...appJotaiStore.get(boardAccessAtom),
        canEdit: false,
      });

      this.notifyOnce(
        "This board could not be read on this browser, so it has been opened " +
          "read-only to protect it. Nothing you do here can overwrite it. " +
          "Open it once on the browser you created it on and it will be " +
          "repaired automatically.",
      );
      return null;
    }

    // `null` (the server holds no scene for this board) and `[]` (it holds one
    // and it is empty) are different answers — see the note in
    // data/storage/lawha.ts — but neither is a reason to write anything to the
    // canvas, and an empty scene is never worth resolving `initialData` with
    // ahead of a peer who may still have something.
    if (!elements || elements.length === 0) {
      return null;
    }

    // The room changed under us while the fetch was in flight. Whatever this
    // is, it is not the board on screen. Asked three ways because they fail
    // separately: the socket can be replaced, the id can move under the same
    // socket object, and the component can go away under both.
    if (
      this.portal.socket !== socket ||
      this.portal.roomId !== roomLinkData.roomId ||
      this.isUnmounted
    ) {
      return null;
    }

    const reconciled = this._reconcileElements(
      elements as unknown as readonly RemoteExcalidrawElement[],
    );

    const scene: CollabSceneData = {
      elements: reconciled,
      scrollToContent: true,
    };

    this.handleRemoteSceneUpdate(reconciled);
    scenePromise.resolve(scene);

    return scene;
  };

  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();

    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    remoteElements = restoreElements(remoteElements, existingElements);

    let reconciledElements = reconcileElements(
      existingElements,
      remoteElements,
      appState,
    );

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } = await this.fetchImageFilesFromBackend(
      {
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      },
    );

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: socketId === this.portal.socket?.id,
        }),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  /**
   * Turns the palette indices on an incoming pointer into a concrete laser
   * colour, using *this* client's theme.
   *
   * The interactive canvas is inverted by a CSS filter in dark mode, so each
   * palette entry ships a pre-inverted hex; picking one at the sender would
   * make every laser wrong for anyone on the opposite theme. The cursor colour
   * is left as an index and resolved at paint time by `getClientColor`, which
   * already receives the theme.
   *
   * The sender's own announcement is the last resort, not the first. A pointer
   * is client-written, so preferring it keeps ADR 0006's rule intact — but when
   * it carries no index at all the server's `lawha-identities` colour is both
   * present and trustworthy, and using it is how a laser stops disagreeing with
   * the cursor above it. That gap was reachable in two ordinary cases: a link
   * guest, who has no account to pick a colour with, and any peer whose pointer
   * left before `setPaletteChoices` ran. Both got their assigned colour on the
   * cursor, via `pinnedIdentity`, and a hash of their socket id on the laser.
   *
   * `resolveAllPointerColors` re-runs this for every peer when the local theme
   * flips. ADR 0002 accepted that staleness as unreachable because pointers
   * stream at 30Hz — true only while a peer is *moving*; one sitting still kept
   * a laser resolved for the theme you just left.
   */
  private resolvePointerColors = (
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"],
    socketId?: SocketId,
  ): CollaboratorPointer => {
    const announced = socketId
      ? this.serverIdentities.get(socketId)?.colorIndex
      : undefined;
    const index =
      pointer?.laserColorIndex ??
      pointer?.colorIndex ??
      (typeof announced === "number" ? announced : undefined);

    if (typeof index !== "number") {
      // Nothing anywhere: LaserTrails falls back to getClientColor.
      return pointer;
    }

    const entry = COLLABORATOR_PALETTE[index];
    if (!entry) {
      return pointer;
    }

    return {
      ...pointer,
      laserColor:
        this.excalidrawAPI.getAppState().theme === THEME.DARK
          ? entry.hexDark
          : entry.hex,
    };
  };

  /**
   * Re-resolves every peer's stored laser colour against the current theme.
   *
   * Called when the local theme changes. Each entry keeps its indices on the
   * pointer, so this is a pure re-read of the palette — no wire traffic, and
   * nothing about anyone's identity is re-derived.
   */
  public resolveAllPointerColors = () => {
    if (this.collaborators.size === 0) {
      return;
    }

    const collaborators = new Map(this.collaborators);
    let changed = false;

    for (const [socketId, collaborator] of collaborators) {
      if (!collaborator.pointer) {
        continue;
      }
      const pointer = this.resolvePointerColors(
        collaborator.pointer as SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"],
        socketId,
      );
      if (pointer.laserColor !== collaborator.pointer.laserColor) {
        collaborators.set(socketId, { ...collaborator, pointer });
        changed = true;
      }
    }

    if (changed) {
      this.collaborators = collaborators;
      this.excalidrawAPI.updateScene({ collaborators });
    }
  };

  /**
   * Merges the server's identity announcement into the collaborator map.
   *
   * This is the payoff for the wire-format change. Three things become possible
   * that were not before:
   *
   *  - `id` is a real account id, so `useLawhaPresence` — which already deduped
   *    on it — finally collapses one person's two tabs into one avatar instead
   *    of showing them as two strangers;
   *  - `avatarUrl` can be built for a *peer*, because there is at last
   *    something to fetch a picture by. The server only sends `avatarId` for
   *    accounts that opted in, so absence here means "not shared", never "not
   *    loaded";
   *  - a link guest is marked as one, rather than being indistinguishable from
   *    a signed-in viewer.
   *
   * Additive by construction: membership stays the business of
   * `room-user-change`, so an identity for a socket that has since left is
   * merged into an entry the next membership array will drop, and never
   * resurrects anyone.
   */
  public handleIdentities = (identities: readonly LawhaIdentity[]) => {
    if (!Array.isArray(identities) || identities.length === 0) {
      return;
    }

    const collaborators = new Map(this.collaborators);

    for (const identity of identities) {
      const socketId = identity?.socketId as SocketId | undefined;
      if (!socketId) {
        continue;
      }

      const existing = collaborators.get(socketId);
      this.serverIdentities.set(socketId, identity);

      collaborators.set(socketId, {
        ...existing,
        // `userId ?? socketId` rather than `userId` alone: a guest has no
        // account, and falling back to the socket keeps every collaborator
        // keyed by *something*, which is what the presence dedupe needs.
        id: identity.userId ?? socketId,
        // Kept if the server sends nothing, because a pointer payload may
        // already have carried a name and losing it would blank the cursor.
        username: identity.username || existing?.username || null,
        colorIndex:
          typeof identity.colorIndex === "number"
            ? identity.colorIndex
            : existing?.colorIndex ?? null,
        // Built exactly as the DOM builds it, so the same person's picture is
        // one URL and therefore one cache entry across canvas and chrome.
        avatarUrl:
          (identity.userId && avatarUrl(identity.userId, identity.avatarId)) ||
          undefined,
        isGuest: identity.isGuest === true,
        isCurrentUser: socketId === this.portal.socket?.id,
      });
    }

    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });

    // The announcement is usually *later* than the first pointer, so a peer's
    // stored laser colour was resolved before their colour was known. Without
    // this, the identity fallback in `resolvePointerColors` would not take
    // effect until they happened to move again — and a peer who has stopped
    // moving is exactly the one whose laser is still on screen.
    this.resolveAllPointerColors();
  };

  /**
   * Forces a repaint of the collaborator layer without changing anything in it.
   *
   * A fresh Map, because `updateScene` compares by reference and the whole
   * point of the call is that the *renderer's* cache has changed underneath an
   * unchanged map.
   */
  private republishCollaborators = () => {
    if (this.collaborators.size === 0) {
      return;
    }
    this.collaborators = new Map(this.collaborators);
    this.excalidrawAPI.updateScene({ collaborators: this.collaborators });
  };

  /**
   * The fields a sender does not get to write about itself.
   *
   * Returns nothing for a socket the server has not announced yet, so a peer
   * whose identity has not arrived still takes its name from the pointer
   * payload — which is how this worked before identities existed, and is the
   * difference between "not yet known" and "claimed".
   */
  private pinnedIdentity = (socketId: SocketId): Partial<Collaborator> => {
    const identity = this.serverIdentities.get(socketId);

    if (!identity) {
      return {};
    }

    const pinned: Mutable<Partial<Collaborator>> = {
      id: identity.userId ?? socketId,
      isGuest: identity.isGuest === true,
      avatarUrl:
        (identity.userId && avatarUrl(identity.userId, identity.avatarId)) ||
        undefined,
    };

    // Only pin what the server actually said. An identity carrying no name —
    // possible while a row is being read — must not blank a name a pointer
    // payload already delivered.
    if (identity.username) {
      pinned.username = identity.username;
    }
    if (typeof identity.colorIndex === "number") {
      pinned.colorIndex = identity.colorIndex;
    }

    return pinned;
  };

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.socket?.id,
      },
      // Last, so that a pointer or idle payload cannot rename, recolour or
      // re-identify the peer that sent it.
      this.pinnedIdentity(socketId),
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  /**
   * Somebody renamed this board while it was open here.
   *
   * `AppState.name` is browser-local, so before the server started announcing
   * this a rename reached exactly one screen: the one it was typed on.
   * Everyone else kept the old title indefinitely, with nothing anywhere
   * saying the board had been renamed.
   *
   * Safe to apply while another person is mid-rename in the title field:
   * `LawhaBoardTitle` edits a `draft` of its own and only reads
   * `AppState.name` when the field opens, so this changes the name *behind* an
   * open editor rather than under the caret.
   */
  public handleBoardRenamed = (name: string) => {
    const next = name.trim();
    if (!next || next === this.excalidrawAPI.getAppState().name) {
      return;
    }
    this.excalidrawAPI.updateScene({ appState: { name: next } });
  };

  /**
   * Reads the board's stored name and puts it on screen.
   *
   * Renaming already wrote to the server — `LawhaBoardTitle.commit` PATCHes
   * `/api/boards/:id` — and the write was never the problem. Nothing ever read
   * it back. `AppState.name` is browser-local and is restored from
   * localStorage, and `LocalData.pauseSave("collaboration")` is active for the
   * whole session (invariant 17), so for a shared board it is not even saved
   * there. Reopening the board therefore showed "Untitled", every time, on a
   * board whose name was sitting correctly in the database — a rename that
   * looked like it had been thrown away and had not.
   *
   * Best-effort and silent on failure, like everything else in `data/boards.ts`:
   * a name that could not be fetched leaves the title as it was, which is the
   * behaviour that existed before this.
   *
   * Deliberately does not touch the name for the scratch canvas at `/`, which
   * has no board row to have a name in.
   *
   * **Applied twice, and the second time is the one that sticks.** Setting it
   * once was not enough and the way it failed is worth writing down, because
   * it looked exactly like the bug this method was written to fix. The editor
   * consumes `initialData` when `scenePromise` resolves, and applying it
   * replaces `appState` wholesale — including the `name` this had already put
   * there. So on any board whose scene *loads*, the title was set and then
   * immediately cleared back to "Untitled".
   *
   * What made it hard to see is that it only reproduced on a working board.
   * A board whose scene fails to load resolves the promise with `null`, the
   * editor applies no `initialData`, and the name survives — so the one board
   * that was genuinely broken was the one displaying its title correctly.
   *
   * Awaiting `scenePromise` and re-applying is enough because
   * `handleBoardRenamed` no-ops when the name already matches, so the ordinary
   * case costs one comparison.
   */
  private syncBoardName = async (
    boardId: string,
    scenePromise?: PromiseLike<unknown>,
  ) => {
    try {
      const board = await getBoard(boardId);
      // Re-checked after the await: the route can change under a slow request,
      // and applying this to the wrong board would rename the one you just
      // opened to the name of the one you just left.
      if (!board?.name || this.portal.roomId !== boardId) {
        return;
      }

      this.handleBoardRenamed(board.name);

      if (!scenePromise) {
        return;
      }

      // After the scene lands, and after the editor has had a turn to apply
      // it — `initialData` is consumed in a React effect, so resolving is not
      // the same moment as applying.
      await scenePromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.portal.roomId === boardId) {
        this.handleBoardRenamed(board.name);
      }
    } catch {
      // Nothing to say to the user. The title keeps whatever it had.
    }
  };

  /**
   * Rehydrates this account's undo stack for the open board, once the scene
   * `isEntryApplicable` checks it against is the board's own — not a peer's
   * SCENE_INIT still landing, not a partial fetch.
   *
   * `getSceneElementsIncludingDeleted()` is what gets handed to
   * `isEntryApplicable` as the live scene, and that choice is load-bearing,
   * not incidental. That function's own doc explains why a missing id is
   * treated as safe for an `added`/`removed` entry: reconciliation is per
   * element and never deletes (invariant 3), so a delete always leaves an
   * `isDeleted: true` tombstone behind rather than removing the id — which
   * is the only reason "missing" can be read as "never existed" instead of
   * "not synced to us yet". That reasoning holds only for a *fully
   * reconciled* scene. A map that could be missing an id for some other
   * reason — mid-load, a peer's delete that has not arrived yet — would
   * make the same code path resurrect something a collaborator just
   * deleted, on the one path (restoring history) this feature exists to
   * make safe, not the one it reintroduces the risk on.
   *
   * Chained off `scenePromise` rather than run right after
   * `loadSceneFromServer` returns — and, once it resolves, followed by one
   * more macrotask tick before anything here touches the stack. Both matter
   * for the same underlying reason, `App.initializeScene`
   * (`packages/excalidraw/components/App.tsx:3606`) calling
   * **`this.resetHistory()`** as part of consuming `initialData`, which is
   * the *same* promise this function awaits: `excalidraw-app/App.tsx`
   * resolves it via its own `initializeScene` → `.then()` chain, 2-3
   * microtask hops behind `scenePromise` itself resolving. A continuation
   * that is the first waiter on `scenePromise` would run — and could call
   * `restoreUndoStack` — *before* that chain reaches `resetHistory()`, which
   * would then clear the stack this just installed a moment later, silently.
   * `await new Promise((resolve) => setTimeout(resolve, 0))` forces a
   * macrotask boundary, which runs after every currently-queued microtask —
   * including all of those hops — so this is provably the last writer, not
   * merely the last one observed to win in testing. (On the "alone in the
   * room" path this is *also* the only way the scene reaches the editor at
   * all, since it arrives purely through `initialData` there — but that is a
   * second reason to wait, not the load-bearing one: the `resetHistory()`
   * race is live on every cold load, `syncBoardName` above hit a narrower
   * version of the same gap first.) The three tests in this file that mount
   * and only *then* call `startCollaboration` by hand cannot exercise this:
   * by the time they join, `App.initializeScene` already consumed
   * `initialData` as `null` on mount and will not call `resetHistory()`
   * again for that session, so the race this tick guards against cannot
   * occur under that harness shape. It WAS pinned by
   * `undoHistoryLifecycle.test.tsx`'s "survives the real cold-load ordering"
   * case, which drove an automatic, URL-triggered join instead — the one
   * ordering where this tick actually matters. That file went with
   * `59930dbf`, so nothing checks this now; the name is kept because it says
   * which harness shape a replacement would need, which is the part that took
   * the work. Do not read it as a live guard.
   */
  private restoreUndoHistory = async (
    boardId: string,
    scenePromise: PromiseLike<unknown>,
  ) => {
    try {
      await scenePromise;
    } catch {
      // `loadSceneFromServer` already reported this through `notifyOnce`;
      // there is no scene left to check the stored entries against.
      return;
    }
    // See the method doc: this is not about the scene being freshly applied,
    // it is about running after `App.initializeScene`'s own `resetHistory()`.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (this.isUnmounted || this.portal.roomId !== boardId) {
      return;
    }

    // Read AFTER the awaits, the same way `writeUndoHistory` already does,
    // and not before them. `/b/:boardId` is not behind `RequireSession`
    // (`routes/router.tsx`) — that is deliberate, a link visitor is a
    // narrower principal rather than an absent one (invariant 22) — so Collab
    // can mount and get here while `/auth/me` is still in flight. Reading the
    // atom first would find `user` still null for a signed-in person on a
    // cold load and silently skip the restore, with nothing anywhere to say
    // why the stack came back empty. A link guest has no account to key a
    // store by either way, and nothing of theirs to bring back past this tab.
    const userId = appJotaiStore.get(sessionAtom).user?.id;
    if (!userId) {
      return;
    }

    const stored = await readHistory(userId, boardId);

    // Re-checked after the second await, same as `syncBoardName`: the route
    // can move on while the read is in flight.
    if (this.isUnmounted || this.portal.roomId !== boardId) {
      return;
    }

    // Nothing was ever persisted for this board — leave whatever the live
    // stack already holds alone. `restoreUndoStack([])` here would be a
    // silent wipe, not a no-op, on the one path where the live stack can be
    // non-empty *before* this runs: `startCollaboration(null)` from the
    // plain canvas (Share -> "Start session") deliberately does not reset
    // the scene, so local edits made before sharing — and their undo
    // history — are still on the stack. That room id is freshly minted, so
    // `readHistory` can never return anything for it but `[]`; treating an
    // empty read as "nothing to restore" rather than "restore emptiness" is
    // what keeps that stack intact. Reopening an *existing* board takes the
    // `resetScene()` branch first (`this.excalidrawAPI.resetScene()` above,
    // which clears history as part of its own reset), so the live stack is
    // already empty by the time this runs there — this guard is a no-op on
    // that path, not a behaviour change.
    if (stored.length === 0) {
      return;
    }

    const elements = new Map<string, Record<string, unknown>>(
      this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => [
          element.id,
          element as unknown as Record<string, unknown>,
        ]),
    );

    const deltas: HistoryDelta[] = [];
    for (const raw of stored) {
      const delta = deserialiseDelta(raw);
      if (delta) {
        deltas.push(delta);
      }
    }

    const applicable = deltas.filter((delta) =>
      isEntryApplicable(delta, elements),
    );

    this.excalidrawAPI.history.restoreUndoStack(applicable);

    // Corrupted entries are already logged by `deserialiseDelta` itself; what
    // is worth a user-visible toast is specifically the case ADR 0019 §"skip,
    // never revert" describes — a collaborator changed the same thing while
    // this stack was sitting in storage.
    const staleCount = deltas.length - applicable.length;
    if (staleCount > 0) {
      // Through `t()`, like every other user-facing string in this file. The
      // singular gets its own key rather than an "entr(y/ies)" fudge, using
      // the same `_suffix` variant convention `collabSaveFailed_sizeExceeded`
      // already uses in this file's own diverged `en.json`; `t()` has no
      // plural machinery of its own.
      this.excalidrawAPI.setToast({
        message: t(
          staleCount === 1
            ? "toast.undoHistorySkipped_one"
            : "toast.undoHistorySkipped",
          { count: staleCount },
        ),
      });
    }
  };

  /**
   * Persists the undo stack, debounced so a burst of local edits costs one
   * IndexedDB write rather than one per mutation — see
   * `UNDO_HISTORY_WRITE_DEBOUNCE_MS` — and bounded so an *unbroken* burst
   * cannot defer that write for ever (`UNDO_HISTORY_WRITE_MAX_WAIT_MS`).
   *
   * Reads `getUndoStack()` fresh on every fire rather than closing over
   * whatever delta scheduled it: the debounce can coalesce several edits
   * into one window, and what belongs in storage is whatever the stack holds
   * when the window closes, not just the edit that happened to trigger it.
   */
  private writeUndoHistory = debounceWithMaxWait(
    () => {
      const userId = appJotaiStore.get(sessionAtom).user?.id;
      const boardId = this.portal.roomId;
      // A guest has nothing to key the store by. The `!boardId` half is a
      // cheap second line of defence, not a distinct one: every path that
      // tears a room down — `leaveRoom`, both branches of `stopCollaboration`,
      // `handleAccessRevoked`, `onUnload` — funnels through
      // `destroySocketClient`, which cancels this debounce unconditionally
      // before this could ever fire with a stale `boardId`. Reviewed and
      // enumerated (fix round 2): there is currently no reachable path that
      // reaches a stale `boardId` here without `.cancel()` having already
      // prevented it, so this line has no test of its own — the disjunction
      // of the two was pinned by the unmount test in
      // `undoHistoryLifecycle.test.tsx`, which went with `59930dbf`, so now
      // neither half is. Kept anyway: reading `boardId` fresh
      // here rather than closing over it is free, and is what keeps this
      // function correct on its own terms if a future refactor ever calls it
      // from outside that lifecycle, or adds a new door out of a room and
      // forgets to route it through `destroySocketClient`.
      if (!userId || !boardId) {
        return;
      }

      const entries = this.excalidrawAPI.history
        .getUndoStack()
        .map(serialiseDelta);

      void writeHistory(userId, boardId, entries);
    },
    UNDO_HISTORY_WRITE_DEBOUNCE_MS,
    UNDO_HISTORY_WRITE_MAX_WAIT_MS,
  );

  /**
   * Surfaces a server-side refusal that arrived on an otherwise healthy socket.
   *
   * `join-room` can be rejected after the connection succeeds, so this cannot
   * go through `connect_error`. Reporting it matters more than it looks: the
   * editor would otherwise stay in its collaborating state, attached to no
   * room, and quietly sync nothing.
   */
  public handleServerError = (code: string) => {
    switch (code) {
      case ROOM_ERROR_VIEW_ONLY:
      case ROOM_ERROR_CAN_EDIT: {
        // A permission change, not a failure: the session stays up and the
        // editor moves in or out of view mode. Nothing is torn down — a
        // demoted editor is still allowed to *watch* the board.
        const canEdit = code === ROOM_ERROR_CAN_EDIT;
        appJotaiStore.set(boardAccessAtom, (previous) => ({
          ...previous,
          canEdit,
        }));
        this.setErrorIndicator(
          canEdit ? null : "You now have view-only access to this board.",
        );
        return;
      }
      case ROOM_ERROR_FORBIDDEN:
        this.setErrorDialog(t("errors.collabForbidden"));
        this.handleAccessRevoked();
        return;
      case ROOM_ERROR_BAD_ROOM_ID:
        this.setErrorDialog(t("alerts.invalidEncryptionKey"));
        break;
      default:
        this.setErrorDialog(t("errors.collabSaveFailed"));
    }
    this.stopCollaboration(false);
  };

  /**
   * Access was taken away while this board was open.
   *
   * The work on screen has to land somewhere before anything else happens.
   * `LocalData.pauseSave("collaboration")` is active for the whole session, so
   * the server copy is the only durable one — and the server has just stopped
   * accepting writes from this client. Resuming local saving first, and
   * flushing it rather than leaving it debounced, is what keeps the last few
   * minutes of drawing from evaporating on the next reload.
   *
   * Reading the scene out of the editor is safe here and only here: the editor
   * is alive. The same read during teardown is invariant 20.
   */
  private handleAccessRevoked = () => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToBackend.cancel();
    this.loadImageFiles.cancel();

    appJotaiStore.set(boardAccessAtom, {
      ...FULL_BOARD_ACCESS,
      canAccess: false,
      canEdit: false,
    });

    // Clears the collaboration lock on LocalData.
    this.destroySocketClient();

    LocalData.save(
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      this.excalidrawAPI.getAppState(),
      this.excalidrawAPI.getFiles(),
      () => {},
    );
    LocalData.flushSave();
  };

  /**
   * Re-converges this client with the room after a dropped connection.
   *
   * This is where the "reconnect merges, never overwrites" guarantee is kept.
   * It holds because `reconcileElements` is per-element and version-based, so
   * it is commutative and never deletes: work done here while offline and work
   * done there both survive, regardless of which arrives first.
   *
   * Order matters. Pull the server's copy and merge it in before pushing, so
   * the broadcast carries the union rather than only our half.
   */
  public handleReconnect = async () => {
    const { roomId, roomKey, socket } = this.portal;

    // `roomKey` is passed on but no longer required: the stored scene is
    // plaintext, and the key is only consulted if this board's row predates
    // that. Requiring it would make reconnect a no-op on every current board.
    if (!roomId || !socket) {
      return;
    }

    try {
      const stored = await loadFromBackend(roomId, roomKey, socket);

      if (stored) {
        this.handleRemoteSceneUpdate(
          this._reconcileElements(
            stored as unknown as RemoteExcalidrawElement[],
          ),
        );
      }

      // Re-arm sending before broadcasting. Portal clears `socketInitialized`
      // on reconnect so an incoming SCENE_INIT is not ignored, but the same
      // flag gates `_broadcastSocketData` — leaving it false meant this
      // broadcast was silently dropped and the peer never saw work done while
      // we were away. Nothing else would have set it true again either, so the
      // client stayed mute for the rest of the session.
      this.portal.socketInitialized = true;

      // syncAll, because the delta bookkeeping was just reset: peers may have
      // missed anything sent while the socket was down.
      await this.portal.broadcastScene(
        WS_SUBTYPES.UPDATE,
        this.getSceneElementsIncludingDeleted(),
        /* syncAll */ true,
      );

      this.saveCollabRoomToBackend(
        getSyncableElements(this.getSceneElementsIncludingDeleted()),
      );
    } catch (error: any) {
      console.error("lawha: reconnect merge failed", error);
      this.setErrorIndicator(t("errors.collabSaveFailed"));
    }
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation({
          ...payload,
          // Carried on the pointer rather than announced once on join: a peer
          // who arrives mid-session would otherwise never learn the colours of
          // everyone already in the room.
          pointer: {
            ...payload.pointer,
            colorIndex: this.state.colorIndex,
            laserColorIndex: this.state.laserColorIndex,
          },
        });
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    // Held by reference, unfiltered, because this is a hot path — and because
    // `componentWillUnmount` cannot read the scene back out of the editor. See
    // `leaveRoom`.
    this.lastSyncedElements = elements;
    this.broadcastElements(elements);
    this.queueSaveToBackend();
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToBackend = throttle(
    () => {
      // Re-armed rather than dropped.
      //
      // This used to be a bare `if (socketInitialized)` with no else, and
      // lodash's throttle does not retry: the trailing call was spent, the 5s
      // window reset, and the save simply never happened. That matters more
      // here than it would anywhere else, because `LocalData.pauseSave` is
      // active for the whole session (invariant 17) — the server copy is the
      // *only* durable one, so a skipped save is not a delayed save, it is work
      // that exists nowhere but in the tab.
      //
      // `handleReconnect` does save on its way back up, which hid this: the
      // hole is the path where it never runs at all — the rejoin is refused,
      // `room-user-change` never arrives, or `loadFromBackend` throws and the
      // catch takes the save with it. Re-queueing means persistence resumes on
      // its own the moment sending is possible again, instead of depending on
      // one particular recovery path being reached. It costs one pending timer,
      // and all three teardown paths already `.cancel()` this.
      if (!this.portal.socketInitialized) {
        this.queueSaveToBackend();
        return;
      }

      this.saveCollabRoomToBackend(
        getSyncableElements(
          this.excalidrawAPI.getSceneElementsIncludingDeleted(),
        ),
      );
    },
    SAVE_TO_BACKEND_INTERVAL_MS,
    { leading: false },
  );

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  /**
   * The signed-in account's chosen palette indices, pushed down from App.
   *
   * Held here rather than read from the session inside `onPointerUpdate`,
   * which is throttled to 33ms and must stay cheap — this is the hottest path
   * in the whole app.
   */
  setPaletteChoices = (choices: {
    colorIndex: number | null;
    laserColorIndex: number | null;
  }) => {
    this.setState(choices);
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
