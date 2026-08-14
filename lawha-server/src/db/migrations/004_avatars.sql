-- Profile pictures, and a colour for every account that never got one.
--
-- Written as a new migration rather than by editing 001-003. Those have already
-- run against live databases; 003 exists precisely because 002 was edited after
-- the fact and left early adopters with the wrong columns.

-- The avatar's opaque id, which is also its filename under
-- <filesDir>/avatars/<user id>/<avatar id>. A fresh id is minted on every
-- upload, so it doubles as a cache-busting version token: PublicUser.avatarId
-- is what the client appends as ?v= to a URL served with `immutable`.
--
-- Deliberately NOT a row in `files`. That table's `scope` is a SQL CHECK
-- constraint, which SQLite cannot ALTER without rebuilding a table holding
-- every user's file bytes; its ACL only covers the 'rooms' scope, so any
-- account could overwrite anyone's avatar; everything on that path is
-- contractually client-side encrypted and an avatar has no room key to be
-- encrypted with; and its ids are content hashes that refuse overwrite, while
-- an avatar is mutable by definition.
ALTER TABLE users ADD COLUMN avatar_id TEXT;

-- Sniffed from the uploaded bytes, never trusted from the request header, and
-- constrained to image/png, image/jpeg and image/webp by the upload route.
-- SVG is refused: it is a document that can carry script, and serving one from
-- this origin would be stored XSS against every page that renders an avatar.
-- Stored so GET can answer with a real Content-Type instead of re-sniffing.
ALTER TABLE users ADD COLUMN avatar_mime TEXT;

-- Backfill the cursor colour.
--
-- `color_index` was left NULL at registration, and NULL means "no choice on
-- record", so the client fell back to hash(socketId) — which is regenerated on
-- every reconnect. The visible symptom was a collaborator's cursor changing
-- colour mid-session, and the same person being a different colour to each
-- peer. Registration now assigns an index (UsersRepository.create), and this
-- gives the accounts that predate it the same treatment.
--
-- Spread round-robin over creation order rather than randomly, so re-running
-- this against a copy of the same database produces the same assignment. The
-- 5 is COLLABORATOR_PALETTE_SIZE from packages/common/src/colors.ts, mirrored
-- in lib/validation.ts; SQL cannot import it, so it is asserted from the
-- server side by the account test instead.
--
-- `updated_at` is left alone on purpose: nobody edited their profile, and
-- moving it would make a schema change look like a user action.
UPDATE users
   SET color_index = (rowid - 1) % 5
 WHERE color_index IS NULL;
