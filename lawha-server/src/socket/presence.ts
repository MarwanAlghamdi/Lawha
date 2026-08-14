/**
 * Who is in which room, right now.
 *
 * The dashboard wants to show "2 editing" on a board card, which is live
 * information the HTTP side has no other way to reach — socket.io keeps its
 * membership inside the `io` instance, and the REST routes never see it.
 *
 * Deliberately in memory and deliberately not persisted. It describes
 * connections, not data; a restart drops every socket anyway, so a stored copy
 * could only ever be wrong.
 */
export interface PresenceRegistry {
  join: (roomId: string, socketId: string) => void;
  leave: (roomId: string, socketId: string) => void;
  countFor: (roomId: string) => number;
  /** Counts for many rooms at once, so a board list is one pass. */
  countsFor: (roomIds: readonly string[]) => Record<string, number>;
  rooms: () => number;
}

export const createPresenceRegistry = (): PresenceRegistry => {
  const rooms = new Map<string, Set<string>>();

  return {
    join: (roomId, socketId) => {
      let members = rooms.get(roomId);
      if (!members) {
        members = new Set();
        rooms.set(roomId, members);
      }
      members.add(socketId);
    },

    leave: (roomId, socketId) => {
      const members = rooms.get(roomId);
      if (!members) {
        return;
      }
      members.delete(socketId);
      // Dropped rather than left empty: a long-lived server would otherwise
      // accumulate one entry per board ever opened.
      if (members.size === 0) {
        rooms.delete(roomId);
      }
    },

    countFor: (roomId) => rooms.get(roomId)?.size ?? 0,

    countsFor: (roomIds) => {
      const counts: Record<string, number> = {};
      for (const roomId of roomIds) {
        const size = rooms.get(roomId)?.size ?? 0;
        // Only rooms with someone in them, so the client can treat a missing
        // key as zero and the payload stays small on a big board list.
        if (size > 0) {
          counts[roomId] = size;
        }
      }
      return counts;
    },

    rooms: () => rooms.size,
  };
};
