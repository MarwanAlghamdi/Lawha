-- Folders for the dashboard, and the opt-in that puts a face on a cursor.
--
-- A fifth file rather than an edit to 001-004. See the header on 004: those
-- have already run against live databases, and 003 exists precisely because 002
-- was edited after the fact and left early adopters with the wrong columns. An
-- applied migration is history.

-- Folders belong to a person, exactly as `tags` do.
--
-- Same reasoning: a shared vocabulary means one person renaming "Q3" silently
-- relabels it for everyone they share a board with. Two people can both have a
-- folder called "Clients" and they are different rows.
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Case-sensitive, unlike usernames: a folder name is a label the owner chose,
-- not an identifier anyone else has to type, so "Clients" and "clients" being
-- two folders is a mild annoyance rather than an impersonation risk. The route
-- still refuses an exact duplicate with a 409 instead of quietly creating a
-- second folder the owner cannot tell apart from the first.
CREATE UNIQUE INDEX idx_folders_owner_name ON folders (owner_id, name);

-- Filing is PER USER, which is why this is a junction table and not a
-- `boards.folder_id` column.
--
-- A board shared with three people appears on three dashboards. A single column
-- on `boards` would make filing a property of the board, so the moment one
-- member dropped it into "Archive" it would leave everyone else's "Active" —
-- one person silently reorganising other people's dashboards. `owner_id` here
-- is the person doing the filing, not the board's owner; they are frequently
-- different, and a viewer filing a board they cannot edit is correct.
--
-- The composite primary key is what enforces "at most one folder per board per
-- person". Doing that in application code instead would mean every write path
-- had to remember to delete before inserting, and the one that forgot would
-- leave a board in two folders with no error anywhere.
CREATE TABLE board_folders (
  board_id  TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  owner_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, owner_id)
);

-- Deleting a folder must unfile its boards and never delete one, which the
-- ON DELETE CASCADE above already does. This index is what stops that cascade,
-- and the dashboard's per-folder counts, from scanning the whole table.
CREATE INDEX idx_board_folders_folder ON board_folders (folder_id);

-- The dashboard resolves "which folder is this board in, for me" for every card
-- in one query keyed on the viewer. Without this it is a table scan per load.
CREATE INDEX idx_board_folders_owner ON board_folders (owner_id);

-- Opt-in to showing your profile picture as your canvas cursor.
--
-- Default 0, and that is not a placeholder: this publishes a photograph of the
-- account holder to everyone in the room, which is a privacy choice, and a
-- default must never make that choice on someone's behalf. Every account that
-- predates this migration keeps initials until its owner says otherwise.
ALTER TABLE users ADD COLUMN avatar_on_cursor INTEGER NOT NULL DEFAULT 0;
