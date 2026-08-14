import { openDatabase } from "./db/index.js";
import { AdminSessionsRepository } from "./db/repositories/adminSessions.js";
import { AuditRepository } from "./db/repositories/audit.js";
import { BoardsRepository } from "./db/repositories/boards.js";
import { FilesRepository } from "./db/repositories/files.js";
import { FoldersRepository } from "./db/repositories/folders.js";
import { InvitesRepository } from "./db/repositories/invites.js";
import { MembersRepository } from "./db/repositories/members.js";
import { PasswordResetCodesRepository } from "./db/repositories/passwordResetCodes.js";
import { ScenesRepository } from "./db/repositories/scenes.js";
import { SessionsRepository } from "./db/repositories/sessions.js";
import { TagsRepository } from "./db/repositories/tags.js";
import { UsersRepository } from "./db/repositories/users.js";
import { createMasterPassword } from "./lib/masterPassword.js";
import { guestRegistry } from "./lib/guests.js";
import { createPresenceRegistry } from "./socket/presence.js";
import {
  createCanAccessBoard,
  createResolveBoardPermission,
} from "./socket/authz.js";
import { publishPermissionResolver } from "./socket/liveAccess.js";
import { createMetrics } from "./socket/metrics.js";

import type { LawhaConfig } from "./config.js";
import type { LawhaDatabase } from "./db/index.js";
import type { GuestRegistry } from "./lib/guests.js";
import type { MasterPassword } from "./lib/masterPassword.js";
import type { BoardPermissionResolver } from "./socket/authz.js";
import type { PresenceRegistry } from "./socket/presence.js";
import type { LawhaMetrics } from "./socket/metrics.js";

export interface LawhaContext {
  config: LawhaConfig;
  db: LawhaDatabase;
  users: UsersRepository;
  sessions: SessionsRepository;
  /** Master-password sessions. Not accounts; see migration 007. */
  adminSessions: AdminSessionsRepository;
  /** Append-only record of administrative actions (ADR 0015). */
  audit: AuditRepository;
  boards: BoardsRepository;
  members: MembersRepository;
  /** Invite codes, which grant membership rather than link access (ADR 0014). */
  invites: InvitesRepository;
  /** One-time codes so an account holder can reset their own password. */
  passwordResetCodes: PasswordResetCodesRepository;
  tags: TagsRepository;
  folders: FoldersRepository;
  /** Board scenes, stored in the clear since ADR 0012. */
  scenes: ScenesRepository;
  files: FilesRepository;
  metrics: LawhaMetrics;
  masterPassword: MasterPassword;
  presence: PresenceRegistry;
  guests: GuestRegistry;
  canAccessBoard: (userId: string, boardId: string) => Promise<boolean>;
  /**
   * The full answer — access *and* edit rights — for one principal on one
   * board. `canAccessBoard` is this with everything but `canAccess` dropped.
   */
  resolveBoardPermission: BoardPermissionResolver;
}

export const createContext = (
  config: LawhaConfig,
  db: LawhaDatabase = openDatabase({
    path: config.dbPath,
    key: config.dbKey,
  }),
): LawhaContext => {
  const boards = new BoardsRepository(db);
  const authzOptions = {
    // With auth off (phase 1 dev), a canvas can be opened before any board
    // row exists. With auth on, an unknown board is a hard no.
    allowUnknownBoards: !config.requireAuth,
  };
  const resolveBoardPermission = createResolveBoardPermission(
    boards,
    authzOptions,
  );

  // The socket handshake has no context — `createSocketServer` is handed a
  // fixed set of callbacks by `src/index.ts` — so the resolver is published to
  // a module singleton for it to find. Without this the relay could tell
  // whether a socket may *join* a room but not whether it may *write* to one.
  publishPermissionResolver(resolveBoardPermission);

  return {
    config,
    db,
    users: new UsersRepository(db),
    sessions: new SessionsRepository(db, config.sessionTtlMs),
    adminSessions: new AdminSessionsRepository(db),
    audit: new AuditRepository(db),
    boards,
    members: new MembersRepository(db),
    invites: new InvitesRepository(db),
    passwordResetCodes: new PasswordResetCodesRepository(db),
    tags: new TagsRepository(db),
    folders: new FoldersRepository(db),
    scenes: new ScenesRepository(db),
    files: new FilesRepository(db),
    metrics: createMetrics(),
    masterPassword: createMasterPassword(config),
    presence: createPresenceRegistry(),
    guests: guestRegistry,
    canAccessBoard: createCanAccessBoard(boards, authzOptions),
    resolveBoardPermission,
  };
};
