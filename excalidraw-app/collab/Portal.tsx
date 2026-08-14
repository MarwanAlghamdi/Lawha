import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { newElementWith } from "@excalidraw/element";
import throttle from "lodash.throttle";

import type { UserIdleState } from "@excalidraw/common";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  OnUserFollowedPayload,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { WS_EVENTS, FILE_UPLOAD_TIMEOUT, WS_SUBTYPES } from "../app_constants";
import { isSyncableElement } from "../data";
import { FileManager } from "../data/FileManager";

import type {
  SocketUpdateData,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import type { TCollabClass } from "./Collab";
import type { Socket } from "socket.io-client";

class Portal {
  collab: TCollabClass;
  socket: Socket | null = null;
  socketInitialized: boolean = false; // we don't want the socket to emit any updates until it is fully initialized
  roomId: string | null = null;
  roomKey: string | null = null;
  broadcastedElementVersions: Map<string, number> = new Map();
  /** Set on reconnect, consumed once the room has actually been rejoined. */
  pendingReconnectSync: boolean = false;

  constructor(collab: TCollabClass) {
    this.collab = collab;
  }

  /**
   * `key` is nullable because a board created since ADR 0012 has none — the
   * scene is not encrypted, so there was nothing left to mint one for. It is
   * carried on the portal purely so a board stored before that change can be
   * read once and rewritten in the clear.
   */
  open(socket: Socket, id: string, key: string | null) {
    this.socket = socket;
    this.roomId = id;
    this.roomKey = key;

    // Initialize socket listeners
    this.socket.on("init-room", () => {
      if (this.socket) {
        this.socket.emit("join-room", this.roomId);
        trackEvent("share", "room joined");
      }
    });
    this.socket.on("new-user", async (_socketId: string) => {
      this.broadcastScene(
        WS_SUBTYPES.INIT,
        this.collab.getSceneElementsIncludingDeleted(),
        /* syncAll */ true,
      );
    });
    this.socket.on("room-user-change", (clients: SocketId[]) => {
      this.collab.setCollaborators(clients);

      // The server only sends this after a successful join, so it is the first
      // point at which we may broadcast: the relay drops messages from a socket
      // that is not in the room, and after a reconnect the transport is back
      // well before `join-room` has completed.
      if (this.pendingReconnectSync) {
        this.pendingReconnectSync = false;
        this.collab.handleReconnect();
      }
    });

    // A refused join is not a connection failure, so it arrives on the open
    // socket rather than through connect_error. Without this the client sits in
    // a collaborating UI attached to no room, silently syncing nothing — the
    // worst possible failure mode for a collaboration feature.
    this.socket.on(
      "lawha-error",
      (payload: { code?: string; roomId?: string }) => {
        this.collab.handleServerError(payload?.code ?? "UNKNOWN");
      },
    );

    // The board's own metadata changed under everyone — currently only its
    // name. Server-authored, like `lawha-identities` and for the same reason:
    // it is a fact about the board rather than about the sender, so a peer must
    // not be able to rename someone else's board by claiming it did.
    //
    // The room id is checked rather than trusted. A socket is only ever in one
    // board's room, but this handler survives a reconnect into a different one,
    // and applying a stale event would rename the board you just opened to the
    // name of the board you just left.
    this.socket.on(
      "lawha-board",
      (payload: { boardId?: string; name?: string }) => {
        if (
          typeof payload?.name === "string" &&
          payload.boardId === this.roomId
        ) {
          this.collab.handleBoardRenamed(payload.name);
        }
      },
    );

    // Optional-chained: `io` is the socket.io manager, which a socket stub
    // (as used in tests, or a custom transport) need not provide.
    this.socket.io?.on("reconnect", () => {
      // Two pieces of state survive a reconnect and are now wrong:
      //
      //  1. broadcastedElementVersions records what this client believes peers
      //     already have. Anything sent while the socket was down was never
      //     delivered, but a delta broadcast would still skip it — silent,
      //     permanent divergence, masked only by the 20s full resync.
      //  2. socketInitialized stays true, so the SCENE_INIT handler
      //     short-circuits and the scene the room sends back is ignored.
      this.broadcastedElementVersions = new Map();
      this.socketInitialized = false;
      // Deferred until the room is rejoined; see the room-user-change handler.
      this.pendingReconnectSync = true;
    });

    return socket;
  }

  close() {
    if (!this.socket) {
      return;
    }
    this.queueFileUpload.flush();
    this.socket.close();
    this.socket = null;
    this.roomId = null;
    this.roomKey = null;
    this.socketInitialized = false;
    this.broadcastedElementVersions = new Map();
    this.pendingReconnectSync = false;
  }

  /**
   * `roomKey` is deliberately NOT part of this any more.
   *
   * It used to be, because nothing could be broadcast without something to
   * encrypt with. Broadcasts are plaintext since ADR 0012, so requiring a key
   * here would mean a board with no key — which is every board created since —
   * could join a room and then silently relay nothing. Invariant 4 is
   * unchanged: `socketInitialized` still gates both directions.
   */
  isOpen() {
    return !!(this.socketInitialized && this.socket && this.roomId);
  }

  /**
   * Returns whether the payload actually reached the socket.
   *
   * The boolean is the whole point. This method is a no-op whenever the portal
   * is not open — which is most of a reconnect — and it used to return
   * `undefined` either way, so a caller could not tell "sent" from "silently
   * dropped". `broadcastScene` believed the first and recorded the elements as
   * delivered; see the comment there.
   */
  async _broadcastSocketData(
    data: SocketUpdateData,
    volatile: boolean = false,
    roomId?: string,
  ): Promise<boolean> {
    if (!this.isOpen()) {
      return false;
    }

    const json = JSON.stringify(data);
    const encoded = new TextEncoder().encode(json);

    // Plaintext, with an EMPTY iv as the marker — the same convention the
    // stored scene uses. Keeping the two-argument emit is what lets the relay
    // stay untouched: `lawha-server/src/socket/rooms.ts` forwards
    // `(encryptedData, iv)` opaquely and never looks inside either, so it goes
    // on speaking the client's own vocabulary (invariant 15). It also means a
    // tab still running the previous build can sit in a room with a new one
    // during a deploy, because the receiver branches on this length rather
    // than assuming.
    //
    // The second `isOpen()` re-check that used to sit here is gone with the
    // await it was guarding: encryption was asynchronous, so the portal could
    // close between the first check and the emit. There is no await left
    // between them, so the window it covered no longer exists.
    this.socket?.emit(
      volatile ? WS_EVENTS.SERVER_VOLATILE : WS_EVENTS.SERVER,
      roomId ?? this.roomId,
      encoded.buffer as ArrayBuffer,
      new Uint8Array(0),
    );

    return true;
  }

  queueFileUpload = throttle(async () => {
    try {
      const { oversizedFiles } = await this.collab.fileManager.saveFiles({
        elements: this.collab.excalidrawAPI.getSceneElementsIncludingDeleted(),
        files: this.collab.excalidrawAPI.getFiles(),
      });

      // Reported here rather than thrown, because a file too big to upload
      // must not take the rest of the batch down with it. `saveFiles` only
      // returns each rejected file once, so this does not fire again on every
      // throttled tick for an image that is still on the canvas.
      if (oversizedFiles.size) {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: FileManager.describeOversizedFiles(
              oversizedFiles.size,
            ),
          },
        });
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: error.message,
          },
        });
      }
    }

    let isChanged = false;
    const newElements = this.collab.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (this.collab.fileManager.shouldUpdateImageElementStatus(element)) {
          isChanged = true;
          // this will signal collaborators to pull image data from server
          // (using mutation instead of newElementWith otherwise it'd break
          // in-progress dragging)
          return newElementWith(element, { status: "saved" });
        }
        return element;
      });

    if (isChanged) {
      this.collab.excalidrawAPI.updateScene({
        elements: newElements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, FILE_UPLOAD_TIMEOUT);

  broadcastScene = async (
    updateType: WS_SUBTYPES.INIT | WS_SUBTYPES.UPDATE,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) => {
    if (updateType === WS_SUBTYPES.INIT && !syncAll) {
      throw new Error("syncAll must be true when sending SCENE.INIT");
    }

    // sync out only the elements we think we need to to save bandwidth.
    // periodically we'll resync the whole thing to make sure no one diverges
    // due to a dropped message (server goes down etc).
    const syncableElements = elements.reduce((acc, element) => {
      if (
        (syncAll ||
          !this.broadcastedElementVersions.has(element.id) ||
          element.version > this.broadcastedElementVersions.get(element.id)!) &&
        isSyncableElement(element)
      ) {
        acc.push(element);
      }
      return acc;
    }, [] as SyncableExcalidrawElement[]);

    const data: SocketUpdateDataSource[typeof updateType] = {
      type: updateType,
      payload: {
        elements: syncableElements,
      },
    };

    this.queueFileUpload();

    const sent = await this._broadcastSocketData(data as SocketUpdateData);

    // Recorded *after* the send, and only if it happened.
    //
    // `broadcastedElementVersions` is this client's belief about what peers
    // already hold, and the next delta broadcast skips anything in it. Writing
    // it first meant that anything drawn while the socket was down — the whole
    // reconnect window — was marked delivered and then never sent again: silent,
    // permanent divergence for those elements, papered over only by the 20s full
    // resync, which `leaveRoom` and `stopCollaboration` both cancel. The
    // reconnect handler above clears this map for the same reason; that fixed
    // the half of the problem that happens before the drop, not the half that
    // happens during it.
    if (sent) {
      for (const syncableElement of syncableElements) {
        this.broadcastedElementVersions.set(
          syncableElement.id,
          syncableElement.version,
        );
      }
    }
  };

  broadcastIdleChange = (userState: UserIdleState) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["IDLE_STATUS"] = {
        type: WS_SUBTYPES.IDLE_STATUS,
        payload: {
          socketId: this.socket.id as SocketId,
          userState,
          username: this.collab.state.username,
        },
      };
      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastMouseLocation = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["MOUSE_LOCATION"] = {
        type: WS_SUBTYPES.MOUSE_LOCATION,
        payload: {
          socketId: this.socket.id as SocketId,
          pointer: payload.pointer,
          button: payload.button || "up",
          selectedElementIds:
            this.collab.excalidrawAPI.getAppState().selectedElementIds,
          username: this.collab.state.username,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastVisibleSceneBounds = (
    payload: {
      sceneBounds: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"]["payload"]["sceneBounds"];
    },
    roomId: string,
  ) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"] = {
        type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
        payload: {
          socketId: this.socket.id as SocketId,
          username: this.collab.state.username,
          sceneBounds: payload.sceneBounds,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
        roomId,
      );
    }
  };

  broadcastUserFollowed = (payload: OnUserFollowedPayload) => {
    if (this.socket?.id) {
      this.socket.emit(WS_EVENTS.USER_FOLLOW_CHANGE, payload);
    }
  };
}

export default Portal;
