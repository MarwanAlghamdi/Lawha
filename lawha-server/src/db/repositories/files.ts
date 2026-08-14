import type { FileScope } from "../../protocol.js";
import type { LawhaDatabase } from "../index.js";

export interface FileRow {
  id: string;
  scope: FileScope;
  container_id: string;
  byte_size: number;
  created_at: number;
  created_by: string | null;
}

export class FilesRepository {
  constructor(private readonly db: LawhaDatabase) {}

  find(scope: FileScope, containerId: string, fileId: string): FileRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM files WHERE scope = ? AND container_id = ? AND id = ?",
        )
        .get(scope, containerId, fileId) as FileRow | undefined) ?? null
    );
  }

  /** File ids are content hashes, so re-uploads are a no-op rather than an error. */
  record(params: {
    scope: FileScope;
    containerId: string;
    fileId: string;
    byteSize: number;
    createdBy: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO files (id, scope, container_id, byte_size, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, container_id, id) DO NOTHING`,
      )
      .run(
        params.fileId,
        params.scope,
        params.containerId,
        params.byteSize,
        Date.now(),
        params.createdBy,
      );
  }

  listForContainer(scope: FileScope, containerId: string): FileRow[] {
    return this.db
      .prepare("SELECT * FROM files WHERE scope = ? AND container_id = ?")
      .all(scope, containerId) as FileRow[];
  }
}
