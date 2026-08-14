# 0014 — An invite code grants membership, not link access

**Status:** accepted. **Extends ADR 0007's one share surface and ADR 0012's single gate; changes neither.**

**Affects:** migration `015_board_invites.sql`, `lawha-server/src/lib/inviteCode.ts` (new), `db/repositories/invites.ts` (new), `http/routes/invites.ts` (new), `http/routes/boards.ts`, `http/middleware/errors.ts`, `context.ts`, `http/app.ts`; and on the client `data/invites.ts` (new), `lawha/share/ShareCodes.tsx` (new), `lawha/join/JoinRoute.tsx` (new), `lawha/share/LawhaSharePopover.tsx`, `routes/router.tsx`.

## Context

Sharing had two shapes and a gap between them.

**Named sharing** (`board_members`) is durable, per-person and revocable. It also requires the owner to already know the account exists and to find it in a picker — so it cannot be used to invite somebody who has not signed up yet, and it cannot be used at all by an owner who knows a colleague's face but not their username.

**The link** (`boards.link_access`) requires none of that, and gives up all three properties at once. It is one setting for everybody, so it cannot be revoked for one person; it records nothing, so it cannot say who used it; and — the part people actually hit — **it grants nothing durable.**

That last one is the defect this ADR exists for, and it was reported as an experience rather than a bug: a signed-in visitor opens a shared link, reads the board, and then has no way back to it. No membership row, so nothing on their dashboard, so the next visit needs the link again. Lose the message it arrived in and the board is gone. They were never a _member_ of anything; they were a visitor who happened to be signed in, and invariant 22 is explicit that a link visitor is a narrower principal.

## Decision

**A code is three words, and redeeming one writes a `board_members` row.**

That second clause is the whole design. Redemption does not invent a new kind of access — it uses the one that already exists and is already enforced:

- **`resolveBoardPermission` is untouched.** Invariant 21 keeps its single gate, and a redeemed invite is indistinguishable afterwards from having been added by name. That is what makes it durable, revocable and visible in the roster without a line of new authorization code.
- **A code can never grant `owner`.** It travels by whatever channel is to hand and cannot be recalled once spoken; one that granted ownership would be a way to give the board away by forwarding a message.
- **Only an owner may mint or revoke**, through the same `assertOwner` membership uses. Sharing is an owner's power, not an editor's.
- **Redemption requires an account**, never a guest pass. This is not a hurdle in front of the feature, it _is_ the feature: membership needs a user row to belong to, and an account is what "durable" needs. `RequireSession` already returns people to where they were headed.

### Three words, and what that costs

A board id is 10 random bytes of hex. Unimpeachable as entropy, unusable as speech — nobody dictates `f5d0d3ee863903779dd3` twice the same way. A code exists to be said out loud, so it is three words from a list of 256: about **16.7 million combinations**, which is far short of a board id's 2^80 and small enough that an unthrottled attacker would find a live one.

Three things pay for that, and all three are load-bearing rather than defence in depth:

1. **Redemption is rate limited**, per address (10 per 15 minutes) and per account (20 per hour). Both keys are needed — the address bounds an anonymous prober, the account bounds somebody signed in working through the space from a dozen devices.
2. **Codes expire, and the UI always sets an expiry.** The space being searched is not "every code ever" but "codes live right now", which on a LAN deployment is a handful. The server permits a code with no expiry; the panel never asks for one.
3. **A hit is membership of one board at a role the owner chose.** Not ownership, not the account, not the other boards.

Plus a fourth that is a cap rather than a cost: **at most 20 live codes per board.** Rows are cheap, but every live code is another target, so an unbounded pile is the one way a caller could meaningfully widen the search.

**The word list is chosen so a code survives being spoken.** No homophones — `newt`/`neat` was caught and removed — no near-rhymes inside the list (`basket`/`bucket`, `tide`/`tidy`, `vale`/`valley`, `yarn`/`yarrow`, all caught the same way), nothing with a spelling you would have to ask about. Input is normalised the way people retype what they heard: spaces for hyphens, capitals, a trailing full stop. What is **not** forgiven is a word that is not on the list — correcting a near miss would turn a typo into somebody else's board.

### Two decisions that only showed up in the tests

**An exhausted code must still work for the person who spent it.** The first implementation checked the code's status before checking who was asking, so redeeming a single-use code and then refreshing the page told its own redeemer that it was used up. Refreshing is not a second use.

The fix is a two-part condition — _already a member_ **and** _already redeemed this code_ — and **both halves are load-bearing.** Without the membership check, somebody an owner had removed from the board could let themselves straight back in with a code that is now dead, because their old redemption row would still be sitting there vouching for them. There is a test named after that hole.

**An ex-owner's outstanding codes stop working.** Nothing walks the invite table when a member is removed, so a code minted by somebody since removed would otherwise be a permanent way back in. The check happens when the code is spent: if its minter is no longer an owner, it reads as revoked. Same fact from the holder's side — somebody withdrew it.

### What the panel says, and why

Turning a code off does **not** remove the people it already let in — they are ordinary members now — and the panel says so in as many words. The opposite is the natural assumption, and acting on it means an owner believing they have removed somebody who is still on the board. Revoked codes stay listed with the names they admitted, because an owner deciding whether to remove one of those people needs to see how they arrived.

The join page **previews before it redeems.** Landing on a link and being silently added to a stranger's board is the behaviour every link-based invite has, and the one worth not copying.

## Consequences

**`POST /boards/:id/access` finally has a rate limiter**, which is not strictly part of this change but was found while placing the invite limits. It is the only unauthenticated route in the app and therefore the only oracle — it answers "does this board exist and may I have it" to anybody, and mints a guest cookie when the answer is yes. It had no limiter at all while every route around it did.

**`forbidden` and `notFound` gained an optional error code.** The join page has to tell "expired" from "revoked" from "never existed", and matching on prose is how a reworded sentence becomes a broken branch. Defaulted, so every existing caller keeps the code the client already branches on.

**"No such code" and "that code has expired" are deliberately different answers.** Telling them apart leaks that a code exists — but only to somebody already holding a well-formed one, and the alternative is a person staring at a code they were just handed being told it is wrong when it is merely late. The rate limits are what make that trade affordable.

**A limiter belongs to a server, not to a module.** Both new limiters are built inside their router factory, like every other router's. The first version had them at module scope, which is correct for production — one process, one server — and wrong for anything that starts a second server in the same process, which is what made a test suite exhaust a 15-minute budget in one file.

**The link is not deprecated.** It still does the one thing a code cannot: let somebody with no account watch. What has changed is that it is no longer the only way to hand a board to a person whose username you do not know, so it no longer has to be.
