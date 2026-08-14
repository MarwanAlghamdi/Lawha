import { useEffect, useState } from "react";

import type { ShareTarget } from "./shareOrigins";

/**
 * Whether the tunnel is actually up, asked before somebody copies its link.
 *
 * The defect: on 2026-08-05 a link was handed out through an ngrok tunnel that
 * was not running. The recipient got nothing; the sender had no reason to doubt
 * a URL they had just copied out of the share panel. "Silence is the bug" —
 * this whole file exists because a dead route and a live one looked identical.
 *
 * ## Why this is a HEAD, which is the whole design
 *
 * ngrok puts an abuse interstitial in front of browser-looking requests. It is
 * a **`200`** carrying `text/html` and `ngrok-error-code: ERR_NGROK_6024`, so a
 * probe that trusts `response.ok` reports a warning page as a healthy tunnel.
 * It is generated at ngrok's edge and never reaches nginx — it carries neither
 * `server: nginx` nor `x-content-type-options` — so it can never carry the
 * `Access-Control-Allow-Origin` that `docker/nginx.conf`'s `/healthz` block
 * sends, and a CORS-mode fetch that lands on it rejects with a `TypeError`.
 *
 * The plan for this task took that last sentence and concluded that a CORS
 * `GET` would therefore resolve on a live tunnel and reject on a dead one.
 * **Measured in a real Chromium against the live tunnel, that is false, and
 * this is the bug that nearly shipped:** the interstitial is triggered by
 * User-Agent sniffing, and a browser cannot not-be a browser, so a plain `GET`
 * gets the interstitial *whether the tunnel is up or down*. Both cases reject.
 * The dot would have read `not answering` about a tunnel that was demonstrably
 * up, on every deployment, for ever.
 *
 * What was then measured, from a page on `http://127.0.0.1:9002` against the
 * live tunnel:
 *
 * | request | what the browser got |
 * | --- | --- |
 * | `GET`, CORS | **fails** — `net::ERR_FAILED`, the interstitial |
 * | `GET` + `ngrok-skip-browser-warning`, CORS | **fails** — the header is not safelisted, so it preflights, and the preflight has no `Access-Control-Allow-Headers` to accept it |
 * | **`HEAD`, CORS** | **`200`, `content-type: text/plain`, `access-control-allow-origin: *`, `server: nginx/1.30.2`, no `ngrok-error-code`** |
 *
 * **ngrok does not interstitial a `HEAD`** — six consecutive probes, `up` every
 * time, against a stopped tunnel `down`, against a refused port `down`. That is
 * an observation of behaviour, not a reading of ngrok's source, so it is
 * written down as what was seen rather than as a rule they promise.
 *
 * It also needs nothing from the deployment: it works against the stack exactly
 * as it runs today, where the second row above would have required a new
 * `Access-Control-Allow-Headers` in nginx and a container restart to apply it.
 *
 * ## Three independent reasons a dead route cannot read as alive
 *
 * 1. Nothing there — DNS miss, refused connection, timeout — rejects. Measured.
 * 2. If ngrok ever *did* interstitial a `HEAD`, that response has no
 *    `Access-Control-Allow-Origin`, so CORS rejects it. A future ngrok change
 *    can therefore only produce a false `down`, never a false `up`.
 * 3. If some proxy answered HTML *with* a permissive CORS header, the
 *    `content-type` check below still refuses it. `Content-Type` is a
 *    CORS-safelisted response header, so it is readable cross-origin with no
 *    `Access-Control-Expose-Headers` — measured, not assumed.
 *
 * `mode: "no-cors"` is the trap and must never be used here. Measured against
 * the live tunnel it returns `{type: "opaque", status: 0, body: ""}` — status
 * forced to zero, headers and body unreadable — so every one of the three
 * checks above becomes impossible and the dot could say nothing at all.
 *
 * ## What is deliberately NOT checked
 *
 * A LAN address gets no dot. Not an oversight — a probe there could not mean
 * what a reader would take it to mean. Whether `http://lawha.local` resolves
 * for the person being handed the link is a fact about **their** machine
 * (mDNS fails on some phones, on Windows without Bonjour, and over a tailnet;
 * both failures were hit on this deployment on 2026-08-05), and this browser
 * cannot measure it. From the tunnel side it is not even attemptable: a
 * plain-http fetch from an https page is blocked as mixed content, silently.
 * `ShareTargets` states the asymmetry on screen rather than leaving the missing
 * dot to be read as "checked, and fine".
 */

/**
 * How long to wait before calling a silent tunnel dead.
 *
 * Measured against the live tunnel from the host machine: **0.70s median** for
 * the full round trip including the TLS handshake (six samples, 0.69–0.78s). A
 * visitor further from ngrok's edge, or on mobile data, is a multiple of that,
 * so the constant has to leave them room — seven times the measured median.
 *
 * The asymmetry decides the value. A timeout that is too short produces a false
 * `down`, which costs somebody a link that would have worked; it can never
 * produce a false `up`, which is the failure this dot exists to prevent. So err
 * long. Five seconds is also short enough that "checking…" does not sit there
 * long enough to be mistaken for a stuck panel.
 */
export const TUNNEL_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long an answer is worth reusing.
 *
 * `LawhaPanel` unmounts its content while the panel is shut, so every reopen
 * remounts this hook — without a cache, somebody clicking Share twice puts two
 * requests on a third party's tunnel for an answer that cannot have changed in
 * between. Thirty seconds is long enough to cover the open/close/open loop that
 * happens while composing a message, and short enough that a tunnel stopped
 * deliberately shows up as down on the next look rather than the next hour.
 */
export const TUNNEL_LIVENESS_FRESH_MS = 30_000;

/**
 * What the panel can say about one route.
 *
 * `checking` is a state in its own right and never collapses into `up`. A
 * person looks at this dot precisely because they are about to hand the link to
 * somebody else, so "I do not know yet" rendering as "alive" would be the same
 * defect in a new costume.
 */
export type TunnelLiveness =
  /** Not a route this browser can honestly check. No dot. */
  | "not-checked"
  /** The page being read arrived through this very route. Better than a probe. */
  | "here"
  /** In flight. Not `up`. */
  | "checking"
  | "up"
  | "down";

type ProbeResult = "up" | "down";

/**
 * Is this route reachable right now?
 *
 * `timeoutMs` is a parameter with the shipped value as its default so a test
 * can prove the abort is really wired to the fetch without waiting five seconds
 * for it. Callers in the app pass nothing.
 */
export const probeTunnel = async (
  origin: string,
  timeoutMs: number = TUNNEL_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> => {
  try {
    const response = await fetch(`${origin}/healthz`, {
      // Not a GET. See the header comment: a browser GET gets ngrok's
      // interstitial whether the tunnel is up or down, so it cannot tell them
      // apart. A HEAD is passed through to nginx. Measured, in a real browser,
      // against the live tunnel.
      method: "HEAD",
      // Cross-origin by definition — this is a different origin from the page.
      // `no-cors` would make the answer opaque and unreadable.
      mode: "cors",
      // A cached 200 from an earlier session would report a tunnel that has
      // since been stopped as up.
      cache: "no-store",
      // Not optional. This is a cross-origin request to an origin the visitor
      // did not choose to visit; sending the session cookie there would be a
      // new cookie exposure introduced by a status dot — and ADR 0018's second
      // amendment already records that this deployment's cookie crosses the
      // wire in the clear.
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return "down";
    }

    // The body cannot be the check, because a HEAD has none — and a HEAD is the
    // only request shape that survives ngrok's interstitial. `Content-Type` is
    // what replaces it, and it is a CORS-safelisted response header, so it is
    // readable cross-origin without the endpoint exposing anything further.
    //
    // `startsWith` rather than equality: nginx's `default_type text/plain`
    // sends exactly `text/plain` today, but a charset parameter appearing later
    // must not turn a live tunnel red.
    return (response.headers.get("content-type") ?? "").startsWith("text/plain")
      ? "up"
      : "down";
  } catch {
    // Everything lands here: the `TypeError` from a CORS-blocked interstitial,
    // a DNS failure, a refused connection, and the `AbortError` from the
    // timeout above. None of them is distinguishable from "the tunnel is not
    // running", and none of them is a link worth handing out.
    return "down";
  }
};

/**
 * The answers this tab already has, and the probes still in the air.
 *
 * Module-scoped rather than per-component because the share panel renders a
 * `ShareTargets` block per live invite code **plus** one for the board link — a
 * per-row probe would fire once per row, at somebody else's tunnel, for one
 * answer. `inFlight` collapses the concurrent case and `answers` collapses the
 * sequential one.
 */
const answers = new Map<string, { at: number; result: ProbeResult }>();
const inFlight = new Map<string, Promise<ProbeResult>>();

const freshAnswer = (origin: string): ProbeResult | null => {
  const cached = answers.get(origin);
  if (!cached || Date.now() - cached.at > TUNNEL_LIVENESS_FRESH_MS) {
    return null;
  }
  return cached.result;
};

const sharedProbe = (origin: string): Promise<ProbeResult> => {
  const existing = inFlight.get(origin);
  if (existing) {
    return existing;
  }

  const probe = probeTunnel(origin).then((result) => {
    answers.set(origin, { at: Date.now(), result });
    inFlight.delete(origin);
    return result;
  });

  inFlight.set(origin, probe);
  return probe;
};

/**
 * Throws away everything this module remembers.
 *
 * For tests, and for nothing else — a module-level cache that survives between
 * test files would let one test's stubbed `fetch` answer another test's probe.
 * There is no product reason to call it; the freshness window is what expires
 * an answer in the app.
 */
export const forgetTunnelLiveness = () => {
  answers.clear();
  inFlight.clear();
};

/**
 * The liveness of one share target, for the row that renders it.
 *
 * `pageOrigin` is passed in rather than read from `window` here. Partly so the
 * hook is testable without touching jsdom's location, and partly for the reason
 * `shareOrigins.ts` states at length: a global read inside the share machinery
 * is how the original bug got in. This one is legitimate — it is a question
 * about *this* browser, not about the link — but it belongs at the single call
 * site that can see the DOM, not buried in here.
 */
export const useTunnelLiveness = (
  target: ShareTarget,
  pageOrigin: string,
): TunnelLiveness => {
  // Only the public route, and only from somewhere else.
  //
  // The second half is a measured constraint, not caution. `credentials:
  // "omit"` drops ngrok's own `abuse_interstitial` cookie, so a same-origin
  // probe from a page loaded THROUGH the tunnel gets the interstitial again —
  // and a same-origin request skips CORS entirely, so it would resolve, with an
  // HTML body, and be reported `down` while the reader is demonstrably looking
  // at a working tunnel. The page in front of them is the better evidence.
  const probeOrigin =
    target.kind === "public" && pageOrigin !== target.origin
      ? target.origin
      : null;

  /**
   * The answer, or `null` for "nobody has answered yet".
   *
   * `null` rather than a `"checking"` literal on purpose. React commits the
   * first render to the DOM **before** effects run, so any hopeful literal
   * sitting in this initialiser would be genuinely on screen for a frame — and
   * "unknown must not read as alive" does not have a one-frame exemption. With
   * the absence of an answer being the only way to be un-answered, there is no
   * literal here to get wrong.
   *
   * Seeded from the cache so a reopen goes straight to the answer instead of
   * flashing `checking…` at somebody who looked two seconds ago.
   */
  const [answer, setAnswer] = useState<ProbeResult | null>(() =>
    probeOrigin === null ? null : freshAnswer(probeOrigin),
  );

  useEffect(() => {
    if (probeOrigin === null) {
      // The whole of "unset means today's behaviour exactly": with no public
      // origin configured there is no public target, so no row, so this hook
      // never mounts — and even if it did, this returns before touching the
      // network.
      return;
    }

    const cached = freshAnswer(probeOrigin);
    if (cached) {
      setAnswer(cached);
      return;
    }

    let cancelled = false;
    // Back to un-answered before asking. A row re-pointed at a second address
    // would otherwise keep displaying the first one's result while the new
    // probe is still in the air — an answer shown against an origin it was
    // never about.
    setAnswer(null);

    void sharedProbe(probeOrigin).then((result) => {
      if (!cancelled) {
        setAnswer(result);
      }
    });

    return () => {
      cancelled = true;
    };
    // A cancelled flag rather than an `AbortController`, matching
    // `BoardRoute.tsx`. Deliberate: the probe is SHARED between every row in
    // the panel, so aborting it when one row unmounts would cancel the answer
    // the other rows are still waiting for. `AbortSignal.timeout` already
    // bounds the request, so nothing outlives the panel by more than the
    // timeout, and the answer it produces is still worth caching for the next
    // opening.
  }, [probeOrigin]);

  if (target.kind !== "public") {
    return "not-checked";
  }
  if (pageOrigin === target.origin) {
    return "here";
  }
  // The one place an un-answered probe is given a word, and the word is not a
  // hopeful one. Somebody reads this in the seconds before handing the link to
  // another person.
  return answer ?? "checking";
};
