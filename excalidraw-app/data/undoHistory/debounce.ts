/**
 * A trailing debounce with a ceiling on how long it may keep deferring.
 *
 * `debounce` in `packages/common/src/utils.ts` is trailing-only and has no
 * max-wait, and that is a hole rather than a preference for this caller: every
 * durable edit re-arms the timer, so somebody who keeps drawing never lets it
 * expire, and every path out of a room `.cancel()`s whatever is pending. The
 * result was that continuous work followed by closing the tab persisted
 * *nothing* — the one session shape this feature exists to survive.
 *
 * Flushing on unload is the other obvious fix and is the wrong one. An async
 * IndexedDB write started during `beforeunload`/`pagehide` is not reliably
 * allowed to finish, so it would trade a guaranteed loss for an unpredictable
 * one; and a flush there has to read the editor on the way out, which is the
 * shape invariant 20 exists to forbid. A ceiling needs nothing from teardown:
 * the write has already happened before the tab is closing.
 *
 * Lives here rather than as a `maxWait` option on the shared `debounce`
 * because that file is not among the 14 diverged `packages/` paths invariant
 * 10 permits, and one scheduling helper is not worth making it a fifteenth.
 */
export const debounceWithMaxWait = (
  fn: () => void,
  waitMs: number,
  maxWaitMs: number,
) => {
  let handle = 0;
  /** When the currently-deferred run was *first* asked for, not last. */
  let deferredSince: number | null = null;

  const fire = () => {
    handle = 0;
    deferredSince = null;
    fn();
  };

  const schedule = () => {
    const now = Date.now();
    if (deferredSince === null) {
      deferredSince = now;
    }
    window.clearTimeout(handle);
    // Whichever deadline comes first: the quiet period this call restarts,
    // or the ceiling measured from the first call in this burst. Clamped at
    // zero so an already-overdue ceiling fires on the next tick rather than
    // scheduling into the past.
    const untilCeiling = deferredSince + maxWaitMs - now;
    handle = window.setTimeout(
      fire,
      Math.max(0, Math.min(waitMs, untilCeiling)),
    );
  };

  schedule.cancel = () => {
    window.clearTimeout(handle);
    handle = 0;
    deferredSince = null;
  };

  return schedule;
};
