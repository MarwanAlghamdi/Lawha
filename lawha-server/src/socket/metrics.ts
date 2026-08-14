/**
 * Minimal in-process metrics, exposed as Prometheus text at GET /api/metrics.
 *
 * Room size is bucketed rather than labelled per-room: a label per board would
 * grow cardinality without bound as boards accumulate.
 */

const ROOM_SIZE_BUCKETS = [1, 2, 3, 5, 8, 13, 21] as const;

const bucketFor = (size: number): string => {
  for (const bucket of ROOM_SIZE_BUCKETS) {
    if (size <= bucket) {
      return String(bucket);
    }
  }
  return "+Inf";
};

export interface LawhaMetrics {
  socketConnected: () => void;
  socketDisconnected: () => void;
  messageRelayed: (event: string, payload: unknown) => void;
  roomSizeChanged: (roomId: string, size: number) => void;
  sceneCasConflict: () => void;
  sceneCasWrite: () => void;
  render: () => string;
}

const byteLengthOf = (payload: unknown): number => {
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  if (ArrayBuffer.isView(payload)) {
    return payload.byteLength;
  }
  return 0;
};

export const createMetrics = (): LawhaMetrics => {
  let sockets = 0;
  let sceneCasConflicts = 0;
  let sceneCasWrites = 0;
  const messagesByEvent = new Map<string, number>();
  const bytesByEvent = new Map<string, number>();
  const roomSizes = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string, by: number) => {
    map.set(key, (map.get(key) ?? 0) + by);
  };

  return {
    socketConnected: () => {
      sockets += 1;
    },
    socketDisconnected: () => {
      sockets = Math.max(0, sockets - 1);
    },
    messageRelayed: (event, payload) => {
      bump(messagesByEvent, event, 1);
      bump(bytesByEvent, event, byteLengthOf(payload));
    },
    roomSizeChanged: (roomId, size) => {
      if (size === 0) {
        roomSizes.delete(roomId);
      } else {
        roomSizes.set(roomId, size);
      }
    },
    sceneCasConflict: () => {
      sceneCasConflicts += 1;
    },
    sceneCasWrite: () => {
      sceneCasWrites += 1;
    },
    render: () => {
      const lines: string[] = [];

      lines.push("# TYPE lawha_sockets gauge");
      lines.push(`lawha_sockets ${sockets}`);

      lines.push("# TYPE lawha_rooms gauge");
      lines.push(`lawha_rooms ${roomSizes.size}`);

      lines.push("# TYPE lawha_socket_messages_total counter");
      for (const [event, count] of messagesByEvent) {
        lines.push(`lawha_socket_messages_total{event="${event}"} ${count}`);
      }

      lines.push("# TYPE lawha_socket_bytes_total counter");
      for (const [event, bytes] of bytesByEvent) {
        lines.push(`lawha_socket_bytes_total{event="${event}"} ${bytes}`);
      }

      const buckets = new Map<string, number>();
      for (const size of roomSizes.values()) {
        bump(buckets, bucketFor(size), 1);
      }
      lines.push("# TYPE lawha_room_size gauge");
      for (const [bucket, count] of buckets) {
        lines.push(`lawha_room_size{bucket="${bucket}"} ${count}`);
      }

      lines.push("# TYPE lawha_scene_cas_writes_total counter");
      lines.push(`lawha_scene_cas_writes_total ${sceneCasWrites}`);
      lines.push("# TYPE lawha_scene_cas_conflicts_total counter");
      lines.push(`lawha_scene_cas_conflicts_total ${sceneCasConflicts}`);

      return `${lines.join("\n")}\n`;
    },
  };
};
