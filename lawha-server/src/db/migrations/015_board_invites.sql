-- Invite codes, which grant MEMBERSHIP rather than link access.
--
-- Sharing had two shapes and a gap between them. Named sharing
-- (`board_members`) is durable, per-person and revocable, but it needs the
-- owner to already know the account exists and to find it in a picker. The
-- link (`boards.link_access`) needs none of that, and gives up all three: it
-- is one setting for everybody at once, so it cannot be revoked for one
-- person, cannot say who used it, and — the part people actually hit —
-- **grants nothing durable.** A signed-in visitor who opens a shared link can
-- read the board and then has no way back to it: no membership row, so it is
-- absent from their dashboard, so the next visit needs the link again. Lose
-- the message it came in and the board is gone.
--
-- A code closes the gap by being the first mechanism that is *both*: as easy
-- to hand over as a link, and as durable and revocable as a name.
--
--   * **Redemption writes a `board_members` row.** That is the whole design.
--     `resolveBoardPermission` is untouched, invariant 21 keeps its single
--     gate, and a redeemed invite is indistinguishable afterwards from having
--     been added by name — which is what makes it durable.
--   * **The code is three words**, so it can be said out loud across a room or
--     over a phone. See ADR 0014 for the entropy this costs and the rate
--     limiting that pays for it.
--   * **Revocation is real.** Revoking a code stops future redemptions; the
--     members it already made are removed the ordinary way, one at a time,
--     because they are ordinary members. Those are two different intentions
--     and collapsing them would make "stop sharing this" silently evict
--     people.
--
-- Redemptions are their own table rather than a counter, so the owner can be
-- told *who* came in through a code and when. A `uses` column would have been
-- one integer and no answer to that question, and would have needed keeping in
-- step with reality on every path.

CREATE TABLE IF NOT EXISTS board_invites (
  code        TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  -- 'viewer' or 'editor'. Never 'owner': a code that could be forwarded into
  -- ownership is a code that can give the board away.
  role        TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  -- NULL means it does not expire. Every code the UI mints sets one.
  expires_at  INTEGER,
  -- NULL means unlimited. 1 is the "invite exactly this one person" case.
  max_uses    INTEGER,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_board_invites_board
  ON board_invites (board_id);

CREATE TABLE IF NOT EXISTS board_invite_redemptions (
  code        TEXT NOT NULL REFERENCES board_invites(code) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at INTEGER NOT NULL,
  -- One row per person per code: redeeming twice is idempotent rather than a
  -- second use, so refreshing the join page cannot burn a single-use invite.
  PRIMARY KEY (code, user_id)
);
