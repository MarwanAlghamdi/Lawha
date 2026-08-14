/**
 * Who to tell when something is wrong — **blank until you fill it in.**
 *
 * One place, because the alternative is the same sentence copied into four
 * screens and a person's name going stale in three of them. Change these and
 * every surface that shows them changes with it.
 *
 * EMPTY IS THE SHIPPED VALUE, and that is the whole reason this file reads the
 * way it does. It used to carry one deployment's administrator and one
 * organisation's chat tool, hard-coded — so every stranger who cloned Lawha
 * shipped a UI telling their users to message somebody they have never heard
 * of, on a system they may not run. A default that is wrong everywhere except
 * one building is worse than no default, because nobody notices it is there.
 *
 * WHAT HAPPENS WHILE IT IS EMPTY. Nothing breaks and nothing says "undefined".
 * Every surface that reads these has a sentence for both cases and neither is a
 * placeholder: `/reset` and the sign-in note fall back to "an administrator",
 * which is true, and the dashboard footer — a nicety rather than a recovery
 * path — is not rendered at all. Search `hasLawhaContact` for the four of them.
 *
 * WHY FILLING IT IN IS WORTH DOING. There is no email anywhere in Lawha
 * (invariant 9), so the recovery path for a forgotten password is a person, and
 * "ask an administrator" is true and useless to somebody who does not know who
 * that is or how to reach them. Naming them is the entire point of these
 * strings. On a deployment with more than one user, set them.
 *
 * It is a source file rather than a server setting because `./run.sh` builds
 * the frontend from this tree anyway — edit, `./run.sh`, done. If you would
 * rather it were `lawha.env`, that is a real improvement and a bigger one: it
 * needs a field on `GET /api/auth/config` and a client that reads it.
 *
 * Deliberately not an email address (invariant 9) and deliberately not a
 * `mailto:` or a deep link: this is a name and a place to look for it, on a
 * network where everyone already has the directory. A link that opened the
 * wrong client would be worse than text somebody can read and act on.
 */

/**
 * Who to contact. Just the handle, as colleagues would type it.
 *
 * e.g. "a.smith", "@ateam", "the IT desk"
 */
export const LAWHA_CONTACT_HANDLE: string = "";

/**
 * Where to find them — whatever your people actually use.
 *
 * e.g. "Slack", "Teams", "Matrix", "the group chat"
 */
export const LAWHA_CONTACT_CHANNEL: string = "";

/** The invitation, as one sentence. Shown only when the two above are set. */
export const LAWHA_CONTACT_PROMPT = "Found a bug, or want something changed?";

/**
 * True when this deployment has named somebody reachable.
 *
 * BOTH halves, not either: "Message a.smith on " and "Message  on Slack" are
 * each a sentence with a hole in it, and a half-filled contact is the one state
 * nobody tests. The annotations above are `: string` rather than inferred for
 * this function's sake — an inferred `""` makes the comparison a type error
 * about a condition that can never be true, on the very line whose whole job is
 * to notice that somebody changed it.
 */
export const hasLawhaContact = (): boolean =>
  LAWHA_CONTACT_HANDLE.trim().length > 0 &&
  LAWHA_CONTACT_CHANNEL.trim().length > 0;
