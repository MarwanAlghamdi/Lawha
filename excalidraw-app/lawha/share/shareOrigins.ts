/**
 * Which addresses this deployment answers to, turned into labelled links.
 *
 * The defect this closes: a share link was built from `window.location.origin`,
 * so **whoever generated it decided which route everyone else took**. A
 * colleague sitting in the same room as the host was handed the ngrok URL and
 * sent out through the tunnel and back in — three network hops and a stranger's
 * server for two machines on the same switch — because the host happened to
 * have the board open that way. The reverse is worse: somebody off-network
 * handed `http://lawha.local/b/...` gets a name that resolves to nothing.
 *
 * **This file reads no globals.** No `window`, no `document`, no
 * `import.meta.env`. That is not tidiness. A single `window.location` read in
 * here re-creates the bug above exactly, because the answer would once again
 * depend on how the person doing the sharing arrived. Everything it needs
 * arrives as an argument, which is also what lets it be tested with the
 * globals taken away.
 *
 * What it is deliberately NOT: a replacement for `getCollaborationLink`
 * (`excalidraw-app/data/index.ts`). That one must keep returning a same-origin
 * URL, because its other caller feeds it to `window.history.pushState`, which
 * throws `SecurityError` on a cross-origin URL — inside a `try`, so a
 * "helpful" change there breaks room-joining for every tunnel visitor and says
 * nothing. Two builders, on purpose.
 */

/**
 * Why a target is being offered, which is the whole reason the panel can
 * label them rather than listing three anonymous URLs.
 *
 * - `lan` — the address to hand somebody on this network. First in the
 *   operator's configured list, and the same one the unauthenticated
 *   `/api/auth/config` publishes as the singular `lanOrigin`.
 * - `lan-fallback` — also on this network, but not the recommended one. A
 *   second hostname, a raw IP for a machine with no DNS, a second interface.
 * - `public` — reachable from outside the network. Slower and via a third
 *   party, which is why it is never first.
 */
export type ShareTargetKind = "lan" | "lan-fallback" | "public";

export interface ShareTarget {
  kind: ShareTargetKind;
  /** The configured origin, trimmed and with any trailing slash removed. */
  origin: string;
  /**
   * `origin + path`, and exactly that — the invariant is pinned by a test.
   * The two are rendered in different places (the origin as a label, the url
   * as the thing copied), so a divergence would read as "I copied the LAN
   * link" while something else went on the clipboard.
   */
  url: string;
}

/**
 * The body of `GET /api/auth/origins`, verbatim.
 *
 * `lanOrigins` is `[]` and never null when unset — the opposite of the
 * server's own `LawhaConfig.lanOrigins`, and deliberately so: this is a list
 * the client maps over, and `[]` is the shape that needs no special case.
 * `publicShareOrigin` stays nullable because it is a single value, and "no
 * public route" is a fact worth stating rather than an empty container.
 */
export interface ShareOrigins {
  lanOrigins: string[];
  publicShareOrigin: string | null;
}

/**
 * An origin the panel can actually offer, or null.
 *
 * Typed wider than `ShareOrigins` promises on purpose: this data crossed a
 * network, and a payload that arrives with a null inside `lanOrigins` would
 * otherwise become the string "null" in a URL and be copied to somebody.
 */
const usableOrigin = (origin: string | null | undefined): string | null => {
  if (typeof origin !== "string") {
    return null;
  }
  // Trailing slashes go here and only here, which is what makes `${origin}${path}`
  // safe everywhere below — `//b/<id>` is not the same path to nginx, and the
  // person who receives it cannot tell it from a board that was deleted.
  const trimmed = origin.trim().replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
};

/**
 * Every way to reach `path` on this deployment, best first.
 *
 * `path` is expected to start with `/` — every caller passes `/b/<id>` or
 * `/join/<code>`. Normalised rather than trusted anyway: being wrong produces
 * a link that 404s for the one person it was made for.
 *
 * An origin that is empty, whitespace or null produces **no entry at all**,
 * never an entry with an empty `origin`. A blank row with a Copy button that
 * puts a bare path on the clipboard is worse than one fewer option.
 */
export const buildShareTargets = (
  origins: ShareOrigins,
  path: string,
): ShareTarget[] => {
  const suffix = path.startsWith("/") ? path : `/${path}`;

  const target = (kind: ShareTargetKind, origin: string): ShareTarget => ({
    kind,
    origin,
    url: `${origin}${suffix}`,
  });

  // `?? []` for the same reason `usableOrigin` takes a wider type than the
  // interface promises: the field is typed `string[]`, but it arrived as JSON.
  const lan = (origins.lanOrigins ?? [])
    .map(usableOrigin)
    .filter((origin): origin is string => origin !== null);

  const targets = lan.map((origin, index) =>
    // The first USABLE entry is the primary, not `lanOrigins[0]` positionally.
    // If entry zero were dropped as blank, indexing the raw array would leave
    // a list of `lan-fallback`s with no `lan` — nothing for the panel to
    // recommend, and "fallback" labelled relative to an entry that does not
    // exist.
    target(index === 0 ? "lan" : "lan-fallback", origin),
  );

  const publicOrigin = usableOrigin(origins.publicShareOrigin);
  if (publicOrigin !== null) {
    // Always last, including when there is no LAN origin at all. It is the
    // slow route through somebody else's server; it is offered, never
    // recommended.
    targets.push(target("public", publicOrigin));
  }

  return targets;
};
