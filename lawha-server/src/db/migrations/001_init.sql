-- Lawha initial schema.
--
-- Identity is username + password only. There is deliberately no email column
-- anywhere in this file; password recovery is an admin CLI, not a mail flow.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  username_display TEXT NOT NULL,
  username_lower   TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  -- index into COLLABORATOR_PALETTE, not a hex value
  color_index      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Uniqueness is case-insensitive so `Alex` and `alex` collide.
CREATE UNIQUE INDEX idx_users_username_lower ON users (username_lower);

CREATE TABLE sessions (
  -- sha256(token): a database leak must not yield live sessions
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE boards (
  -- doubles as the socket.io room id
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL DEFAULT 'Untitled',
  owner_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_opened_at       INTEGER,
  link_access          TEXT NOT NULL DEFAULT 'none'
                       CHECK (link_access IN ('none', 'view', 'edit')),
  -- dashboard fields; unused in phase 1 but cheaper to define now than migrate
  thumbnail_path       TEXT,
  thumbnail_updated_at INTEGER,
  is_archived          INTEGER NOT NULL DEFAULT 0,
  deleted_at           INTEGER
);

CREATE INDEX idx_boards_owner ON boards (owner_id, is_archived, updated_at DESC);
CREATE INDEX idx_boards_updated ON boards (updated_at DESC);

-- Normalised so the dashboard can filter without LIKE scans.
CREATE TABLE tags (
  id       TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  color    TEXT
);

CREATE UNIQUE INDEX idx_tags_owner_name ON tags (owner_id, name);

CREATE TABLE board_tags (
  board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, tag_id)
);

CREATE INDEX idx_board_tags_tag ON board_tags (tag_id);

CREATE TABLE board_members (
  board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_at INTEGER NOT NULL,
  added_by TEXT REFERENCES users (id),
  PRIMARY KEY (board_id, user_id)
);

CREATE INDEX idx_board_members_user ON board_members (user_id);

-- The end-to-end encrypted scene. The server never holds the key and never
-- decrypts this blob.
CREATE TABLE board_scenes (
  board_id      TEXT PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
  -- server-owned, strictly increasing; the only sound compare-and-swap token.
  -- scene_version is NOT usable for this: it is a sum of element versions, so
  -- a client holding fewer elements can still produce a larger value.
  rev           INTEGER NOT NULL,
  scene_version INTEGER NOT NULL,
  iv            BLOB NOT NULL,
  ciphertext    BLOB NOT NULL,
  byte_size     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT REFERENCES users (id)
);

CREATE TABLE files (
  -- excalidraw FileId: a content hash, so uploads are idempotent
  id           TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('rooms', 'shareLinks')),
  container_id TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users (id),
  PRIMARY KEY (scope, container_id, id)
);

CREATE INDEX idx_files_container ON files (scope, container_id);
