-- Folders nest, and carry a colour.
--
-- A sixth file rather than an edit to 005, for the reason 003 exists: an
-- applied migration is history, and 002 was edited after the fact once already.

-- Nesting, and the colour the dashboard paints the dot and the tile with.
--
-- `color_index`, not a hex. Same rule as the laser colour in ADR 0002 and for
-- the same reason: the dashboard renders a folder in both themes, and a colour
-- chosen against one of them is wrong in the other. An index lets the palette
-- be retinted without a migration, and lets a client that does not recognise
-- the index fall back rather than paint something illegible.
--
-- NULL is a real value on both columns: every folder that existed before this
-- migration is a root folder with no colour, and neither of those is an error
-- state the UI has to apologise for.
--
-- No `ON DELETE` action on parent_id, deliberately. SQLite's default is NO
-- ACTION, so deleting a folder that still has children FAILS — and that is the
-- behaviour we want, because it turns "the repository forgot to reparent the
-- children first" into a loud error instead of a silently orphaned subtree.
-- Promote-up is a transaction in FoldersRepository.delete, never a cascade; a
-- cascade here would take a whole subtree of somebody's filing with it, and the
-- server cannot restore filing it has deleted any more than it can restore a
-- scene it has never been able to read.
ALTER TABLE folders ADD COLUMN parent_id   TEXT REFERENCES folders (id);
ALTER TABLE folders ADD COLUMN color_index INTEGER;

-- "Unique among siblings" replaces "unique per owner", and it takes TWO partial
-- indexes rather than one composite.
--
-- The obvious `UNIQUE (owner_id, parent_id, name)` is wrong, and wrong in the
-- silent direction: SQLite treats NULLs as DISTINCT in a unique index, so two
-- root folders both named "Clients" — both with parent_id NULL — would not
-- collide, and the owner would end up with two folders they cannot tell apart.
-- That is exactly the outcome idx_folders_owner_name was created to prevent, so
-- dropping it for a composite would have quietly undone it.
--
-- Splitting on the NULL-ness of parent_id puts every row in exactly one of the
-- two indexes and gives each the comparison it needs.
DROP INDEX idx_folders_owner_name;

CREATE UNIQUE INDEX idx_folders_root_name
  ON folders (owner_id, name)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX idx_folders_child_name
  ON folders (owner_id, parent_id, name)
  WHERE parent_id IS NOT NULL;

-- Every folder here predates nesting, so parent_id is NULL on all of them and
-- idx_folders_root_name enforces precisely the constraint just dropped. No
-- existing database can fail this migration on a duplicate.

-- The sidebar walks the tree top-down, one query per level in the worst case
-- and a recursive CTE in the normal one; both ask "children of X, for owner Y".
CREATE INDEX idx_folders_parent ON folders (owner_id, parent_id);
