import { HistoryDelta } from "@excalidraw/excalidraw/history";

/**
 * A delta as it sits on disk: plain JSON, no class instances.
 *
 * `elements` and `appState` are `unknown` rather than typed, deliberately.
 * What comes back off disk was written by some past build and is not to be
 * trusted into the delta classes without `deserialiseDelta` looking at it
 * first — see the schema stamp in `store.ts` for the other half of that.
 */
export type SerialisedDelta = {
  id: string;
  elements: unknown;
  appState: unknown;
};

export const serialiseDelta = (delta: HistoryDelta): SerialisedDelta => ({
  id: delta.id,
  elements: {
    added: delta.elements.added,
    removed: delta.elements.removed,
    updated: delta.elements.updated,
  },
  appState: { delta: delta.appState.delta },
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Structural check, independent of anything `restore` does downstream.
 *
 * `ElementsDelta.create`'s own invariant checks — the ones that would
 * otherwise catch a shape like this — are wrapped in `isTestEnv() ||
 * isDevEnv()` (`packages/element/src/delta.ts`), so they do not run in the
 * production build. A test suite that relies on that check exercises a
 * guarantee the shipped app does not have. This function has to hold on its
 * own: without it, a corrupted or schema-drifted record — precisely what this
 * module exists to guard against — would silently construct a broken delta
 * in production instead of being dropped.
 */
const hasRestorableShape = (raw: SerialisedDelta): boolean => {
  if (!isPlainObject(raw.elements) || !isPlainObject(raw.appState)) {
    return false;
  }

  const { added, removed, updated } = raw.elements;

  return (
    isPlainObject(added) &&
    isPlainObject(removed) &&
    isPlainObject(updated) &&
    isPlainObject(raw.appState.delta)
  );
};

/**
 * `null` rather than a throw, and `null` rather than a partial delta.
 *
 * A delta we cannot fully rebuild is not a delta to apply — half an undo is
 * corruption, and the caller's answer to `null` is to drop the entry, which is
 * always safe.
 *
 * Restores through `HistoryDelta`, not `StoreDelta`: `StoreDelta.restore` is
 * `return new this(...)`, and a static's `this` is the class it was called
 * through, so calling it on the base class would build a `StoreDelta`, not a
 * `HistoryDelta`. `HistoryDelta` overrides the instance method `applyTo`,
 * which is exactly what `History.perform` calls to apply an undo entry — a
 * `StoreDelta` merely cast to the `HistoryDelta` type would pass the type
 * checker and then fail at the first undo with "applyTo is not a function".
 *
 * The `as HistoryDelta` below is still needed, but it is no longer the lie
 * it would have been on `StoreDelta.restore`: `restore` isn't one of the
 * statics `history.ts` re-declares with a polymorphic `this` return (unlike
 * `calculate`/`inverse`/`applyLatestChanges`, each overridden there for
 * exactly this reason — see its "avoid type casting everywhere" comment), so
 * `tsc` still infers `StoreDelta` from the inherited signature even though
 * `this` resolves to `HistoryDelta` at the call site. The object this
 * returns at runtime genuinely is a `HistoryDelta` — proven by
 * `toBeInstanceOf` in the test — so the cast is only correcting what the
 * type checker cannot see, not asserting past a mismatch the way the
 * previous version did.
 */
export const deserialiseDelta = (
  raw: SerialisedDelta | null | undefined,
): HistoryDelta | null => {
  if (!raw || typeof raw.id !== "string" || !hasRestorableShape(raw)) {
    return null;
  }
  try {
    return HistoryDelta.restore(raw as never) as HistoryDelta;
  } catch (error) {
    console.warn("lawha: dropped an unreadable undo entry", error);
    return null;
  }
};
