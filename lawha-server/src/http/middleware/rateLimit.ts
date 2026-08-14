import { tooManyRequests } from "./errors.js";

import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  message?: string;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * In-process token buckets. Single-node by design: this is a self-hosted LAN
 * service, and a Redis dependency would cost more than it buys.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly options: RateLimiterOptions) {}

  /** @returns ms until reset when blocked, or null when allowed. */
  check(key: string, now = Date.now()): number | null {
    /**
     * `limit: 0` is OFF, not "allow nothing".
     *
     * Read the other way round it is a lockout of everybody, which is the more
     * literal reading and the reason this is stated here rather than left to
     * the caller — 0 is the house convention for "disabled" across this
     * project's settings (`LAWHA_BACKUP_INTERVAL_HOURS`, `LAWHA_SESSION_TTL_DAYS`),
     * and one limiter quietly meaning the opposite would be found the hard way.
     *
     * It returns before `sweep`, and before any bucket is written: a disabled
     * limiter must not accumulate state it will never read, or turning it back
     * on would apply a window that had been filling invisibly the whole time.
     */
    if (this.options.limit <= 0) {
      return null;
    }

    this.sweep(now);

    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return null;
    }

    if (bucket.count >= this.options.limit) {
      return bucket.resetAt - now;
    }

    bucket.count += 1;
    return null;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

const minutes = (ms: number) => Math.ceil(ms / 60_000);

/**
 * The one sentence a rate-limited caller is ever told.
 *
 * Exported because not every limit can be a middleware. The master-password
 * budget in `routes/auth.ts` is only known to apply *after* the account's own
 * password has been rejected, which is halfway through the handler — and two
 * hand-written copies of this sentence would drift the moment either one was
 * reworded.
 */
export const retryMessage = (retryInMs: number): string =>
  `Too many attempts. Try again in ${minutes(retryInMs)} minute(s).`;

export const rateLimit =
  (limiter: RateLimiter, keyOf: (req: Request) => string) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const retryInMs = limiter.check(keyOf(req));
    if (retryInMs === null) {
      next();
      return;
    }
    next(tooManyRequests(retryMessage(retryInMs)));
  };

export const clientIpOf = (req: Request): string =>
  req.ip ?? req.socket.remoteAddress ?? "unknown";

/**
 * Keys a limiter on the signed-in caller, falling back to the address.
 *
 * The two namespaces are kept apart deliberately. `/api/admin` is reachable —
 * and refused — by anyone who guesses the path, so its limiter has to sit in
 * front of the authorization check to bound that traffic at all. Keying an
 * anonymous prober and a signed-in administrator into the *same* bucket would
 * then hand any device on the LAN a way to lock the administrator out of the
 * recovery panel by hammering it from behind the same NAT address.
 */
export const callerOf = (req: Request): string => {
  if (req.user) {
    return `u:${req.user.id}`;
  }
  // A master-password session has no user, so without this it would fall into
  // the shared `ip:` bucket — which on this router is the *anonymous* bucket,
  // the one an attacker guessing the path is filling. Filling it must not lock
  // the operator out of the recovery panel, which is the whole reason
  // `callerOf` exists rather than keying on the address alone.
  if (req.masterAdmin === true) {
    return `master:${clientIpOf(req)}`;
  }
  return `ip:${clientIpOf(req)}`;
};

/**
 * Escalating delay after repeated failures for one username. Slows credential
 * stuffing without locking a real user out of their own account.
 *
 * `threshold: 0` disables it, for the same reason and by the same convention as
 * `RateLimiter`'s `limit: 0` above. It is switched off alongside the
 * per-username limiter rather than separately: a deployment that has decided
 * sign-in attempts are not to be counted has not decided they should instead be
 * slept on for eight seconds, and two switches for one intent is how a
 * deployment ends up half-configured.
 */
export class FailureBackoff {
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly threshold = 5,
    private readonly baseDelayMs = 1000,
    private readonly maxDelayMs = 8000,
  ) {}

  delayFor(key: string): number {
    if (this.threshold <= 0) {
      return 0;
    }
    const count = this.failures.get(key) ?? 0;
    if (count < this.threshold) {
      return 0;
    }
    const factor = 2 ** (count - this.threshold);
    return Math.min(this.baseDelayMs * factor, this.maxDelayMs);
  }

  recordFailure(key: string): void {
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}

export const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
