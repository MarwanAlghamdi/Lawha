import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ExcalidrawWrapper } from "../App";
import { boardAccessAtom, boardAccessBoardIdAtom } from "../collab/Collab";
import { resolveBoardKey } from "../data/boardKeys";
import { setCurrentBoardId, setCurrentBoardKey } from "../data/currentBoard";

import { useAtomValue } from "../app-jotai";

/** `#key=<k>`, as it arrives on a share link. */
const readKeyFromHash = (): string | null =>
  window.location.hash.match(/^#key=([a-zA-Z0-9_-]+)$/)?.[1] ?? null;

type Resolution = { state: "resolving" } | { state: "ready" };

/**
 * The canvas, for one board.
 *
 * Two things have to happen before the editor mounts, and both are why this is
 * a wrapper rather than a route pointing straight at `ExcalidrawWrapper`:
 *
 *  - `setCurrentBoardId` must be set first, because the local scene cache is
 *    keyed by it. Mounting the editor and then setting it would give the new
 *    board a first paint of the previous board's elements.
 *  - the board's key, if this board still has one, has to be resolved before
 *    the editor mounts, because `getBoardLinkData` reads it synchronously. It
 *    is only ever needed to read a scene stored before ADR 0012; a board that
 *    resolves no key opens exactly the same way.
 */
export const BoardRoute = () => {
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();

  /**
   * Somebody stopped sharing this board while it was open.
   *
   * `Collab.handleAccessRevoked` already does the part that cannot wait: it
   * flushes the scene to local storage before tearing the socket down, because
   * `LocalData.pauseSave("collaboration")` is active for the whole session and
   * the server has just stopped accepting writes. What it did NOT do is move
   * the person anywhere — so they were left sitting on a board they can no
   * longer read or save, with an error dialog over it and a URL that will do
   * the same thing again on reload.
   *
   * Navigating belongs here rather than in `Collab`, which is a class with no
   * router in scope; reaching for one there would put routing inside the
   * collaboration client for a single call.
   *
   * `canAccess` used to read straight off `boardAccessAtom`, on the claim
   * that it "starts true and only ever goes false through revocation, so
   * this cannot fire on an ordinary load." That was true of any *single*
   * board looked at in isolation, and false of the atom itself: it is one
   * global slot with no board id attached to it, so a denial left behind by
   * the board just closed — whether from `refreshBoardAccess` at load or
   * `handleAccessRevoked` mid-session — was still sitting there, unchanged,
   * on the very first render of a completely different, fully accessible
   * board. This effect fired on that stale value and bounced to `/` before
   * the new board's own access check had even started, several awaits
   * before `refreshBoardAccess` runs inside `startCollaboration`.
   *
   * `boardAccessBoardIdAtom` names which board `boardAccessAtom`'s value is
   * actually about. Until it agrees with the board this route is showing,
   * `canAccess` stays optimistic rather than trusting a stranger's refusal —
   * the same "assume access, let the server refuse" default the atom itself
   * starts with. `replace` so the back button does not return them to a
   * board that will bounce them again.
   */
  const boardAccess = useAtomValue(boardAccessAtom);
  const boardAccessResolvedFor = useAtomValue(boardAccessBoardIdAtom);
  const canAccess =
    boardAccessResolvedFor === boardId ? boardAccess.canAccess : true;
  useEffect(() => {
    if (!canAccess) {
      navigate("/", { replace: true });
    }
  }, [canAccess, navigate]);

  const [resolution, setResolution] = useState<Resolution>({
    state: "resolving",
  });

  useEffect(() => {
    if (!boardId) {
      return;
    }

    let cancelled = false;

    // Set synchronously, before the await below: an editor that mounts while
    // this is still the previous board's id reads the wrong cache.
    setCurrentBoardId(boardId);

    // **A key is no longer required to open a board, and this effect no longer
    // decides whether one opens.** Scenes are plaintext (ADR 0012), so the only
    // thing a key is still good for is reading a board stored before that
    // change — and the resolution is best-effort for exactly that reason. It
    // used to gate the whole route, which is what produced the "This board is
    // locked here" screen on somebody's own board, on their own account,
    // whenever the browser had not derived their master key.
    //
    // Whether a board opens is now `resolveBoardPermission` on the server and
    // nothing else. If it refuses, the scene read 403s and that is reported —
    // by the layer that actually knows, rather than guessed at here from the
    // absence of a key.
    void resolveBoardKey(boardId, readKeyFromHash()).then((key) => {
      if (cancelled) {
        return;
      }
      // Published before the editor mounts, because `getBoardLinkData` reads it
      // synchronously to decide whether `/b/<id>` is a room worth joining.
      setCurrentBoardKey(boardId, key);
      setResolution({ state: "ready" });
    });

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Held blank rather than spinning: the key store answers in a frame or two,
  // and a spinner that flashes reads as a fault.
  if (resolution.state === "resolving") {
    return <div className="lw-route-pending" aria-busy="true" />;
  }

  // Keyed on the board so switching boards remounts the editor rather than
  // trying to swap a scene underneath a live one.
  return <ExcalidrawWrapper key={boardId} />;
};
