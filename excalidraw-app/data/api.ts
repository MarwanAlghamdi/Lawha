/**
 * The two things every call to Lawha's own API needs, in one place because
 * they were in five and three of them had drifted.
 */

/** Where the API lives. Same origin, always — nginx proxies `/api` through. */
export const API_BASE = "/api";

/**
 * Sent on every request, and ignored by every deployment except one.
 *
 * When Lawha is reached through a free ngrok tunnel, ngrok answers requests it
 * thinks are browser navigations with its own interstitial warning page — and
 * "thinks" is generous: measured against the live tunnel, a `GET` carrying a
 * browser `User-Agent` gets that page for `/healthz` and `/api/auth/config`
 * alike. It arrives as **HTTP 200** with `content-type: text/html`, so a
 * caller that checks `response.ok` sees success and then calls
 * `response.json()` on a web page:
 *
 *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * — which names neither the endpoint nor the cause, and points at Lawha for
 * something Lawha did not do. Reported live on this deployment.
 *
 * Clicking through the page sets a cookie that suppresses it, so in the
 * ordinary flow — load the app, click once — the API is never hit before the
 * cookie exists. This header covers the cases where it is: a cookie that
 * expired or was cleared while the tab stayed open, a private window, and the
 * one that matters most, **a `/join/<code>` or `/reset/<code>` link opened by
 * somebody who has never seen this deployment before**. That person is the
 * whole point of those links and has no cookie by construction.
 *
 * Any value works; ngrok only checks the header's presence. It is a
 * same-origin request, so it triggers no CORS preflight, and on a deployment
 * with no ngrok in front it is an unknown request header that nothing reads.
 *
 * **Spread this into every fetch at Lawha's own API.** It was copied by hand
 * into two of the five clients and missed in the other three — `boards.ts`,
 * `invites.ts` and `storage/lawha.ts` — which is why it now lives here instead
 * of in a comment somebody has to remember to copy.
 */
export const NGROK_SKIP_HEADER = {
  "ngrok-skip-browser-warning": "lawha",
} as const;

/**
 * A response body parsed as JSON, or `null` when it is not JSON at all.
 *
 * The `catch` is not defensive padding: the two bodies that reach a caller
 * expecting JSON are ngrok's interstitial above and nginx's own HTML error
 * pages, which it serves for a 502 or 504 when `lawha-server` is down — and
 * `docker/nginx.conf` proxies only `/api`, so the SPA keeps loading and only
 * the API answers HTML. A caller that lets `response.json()` throw turns both
 * into a parse error with no status in it.
 */
export const parseJsonBody = async <T>(
  response: Response,
): Promise<T | null> => {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};
