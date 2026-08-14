import { useEffect, useMemo, useState } from "react";

import { fetchShareOrigins } from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";

import type { ShareOrigins } from "./shareOrigins";

/**
 * Every address this deployment answers to, assembled from the two routes that
 * publish them.
 *
 * There are two on purpose, and the split is a security boundary rather than an
 * accident of history. `GET /api/auth/config` has no auth middleware — it is
 * read on boot, before the app knows whether anyone is signed in — so it
 * publishes the ONE recommended LAN address and the public one. The full LAN
 * list, which includes this network's internal addressing, lives behind a
 * session on `GET /api/auth/origins`. Anyone holding the tunnel URL would
 * otherwise learn the shape of the network they are outside of.
 *
 * **The fetch happens when the panel opens, not on boot.** The share panel is
 * the only surface that asks, and it unmounts when closed (Radix does not
 * render popover content while it is shut), so this hook's effect is
 * per-opening by construction. A deployment fact nobody has asked to see is
 * not worth a request on every page load.
 */
export const useShareOrigins = (): ShareOrigins => {
  const { config } = useLawhaSession();
  const [fetched, setFetched] = useState<ShareOrigins | null>(null);

  const lanOrigin = config?.lanOrigin ?? null;
  const publicShareOrigin = config?.publicShareOrigin ?? null;

  useEffect(() => {
    let cancelled = false;

    void fetchShareOrigins()
      .then((origins) => {
        if (!cancelled) {
          setFetched(origins);
        }
      })
      .catch(() => {
        // Not fatal, and deliberately not surfaced. `fetchShareOrigins`
        // already swallows the 401 a link visitor gets, so what reaches here
        // is a 500 or an unreachable server — and in both cases the honest
        // answer for THIS panel is the one the boot config already gave it.
        // The panel's other four sections do not depend on origins at all,
        // and refusing to open it over a fallback link nobody has asked for
        // would be the larger failure.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    // A union that can only grow, never shrink. `/auth/origins` answers `[]`
    // for a signed-out visitor, and taking that literally would DELETE the
    // public link the unauthenticated `/config` had already published to
    // them — a link they may well have arrived on. The authenticated route is
    // a superset whenever it answers at all, so preferring it when it has
    // something to say and keeping the boot config's answer otherwise is
    // correct in both directions.
    const lanOrigins =
      fetched && fetched.lanOrigins.length > 0
        ? fetched.lanOrigins
        : lanOrigin
        ? [lanOrigin]
        : [];

    return {
      lanOrigins,
      publicShareOrigin: fetched?.publicShareOrigin ?? publicShareOrigin,
    };
  }, [fetched, lanOrigin, publicShareOrigin]);
};
