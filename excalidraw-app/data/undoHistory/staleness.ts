import type { HistoryDelta } from "@excalidraw/excalidraw/history";

type ElementLike = { [key: string]: unknown };
type PropertyChange = { deleted: ElementLike; inserted: ElementLike };
type DeltaGroup = { [id: string]: PropertyChange };

/**
 * `version`/`versionNonce` are bumped by *every* mutation of an element, not
 * only the one a given delta recorded. `ElementsDelta.calculate`
 * (packages/element/src/delta.ts) folds them into `deleted`/`inserted`
 * unconditionally — a differing `versionNonce` is literally the signal it
 * uses to decide an element changed at all, so they ride along with every
 * property change it captures.
 *
 * That means the next time *anyone* touches this element — even a property
 * this entry never cared about, recorded on a different, later `HistoryDelta`
 * further up the stack — the live element's `version` moves past what this
 * older, buried entry recorded. Comparing them here would make "a colleague
 * recolouring the element does not invalidate an undo of its position" false
 * for every delta the app actually produces; it is only true of a delta
 * built by hand for a test, which has no reason to include a `version` key.
 * `HistoryDelta.applyTo` already treats these two as bookkeeping rather than
 * content, for the same reason (`excludedProperties` in
 * `packages/excalidraw/history.ts`) — this check has to agree with that, or
 * the two would disagree about what "the same element" means.
 */
const BOOKKEEPING_KEYS = new Set(["version", "versionNonce"]);

/**
 * Value equality that survives a trip through IndexedDB.
 *
 * `===` alone was the whole of this comparison once, and it made the feature
 * not work at all. It is correct in-session, where both sides are the same
 * object — and it is correct for every primitive on either side of a storage
 * round trip, which is why a corpus of primitive-only fixtures could pass
 * while nothing was restorable in the app. What it cannot do is compare a
 * value that came back off disk: `readHistory` hands back the result of
 * `JSON.parse`, so a recorded array is never the same object as the live
 * one, however identical their contents.
 *
 * That would be harmless if deltas only ever recorded primitives. They do
 * not: `ElementsDelta.calculate` (`packages/element/src/delta.ts`) records
 * the *entire* element as `inserted` when one is created, and
 * `ElementsDelta.inverse` makes that the undo entry's `deleted` — the
 * precondition this function checks. Every Excalidraw element carries
 * `groupIds: []`; a linear element also carries `points`, an array of
 * arrays. So every undo-of-creation had an array-valued precondition, and
 * every one of them was judged stale the moment it came back from storage,
 * on a solo board with no collaborator to have changed anything. Undo of a
 * move and undo of a deletion survived, because those deltas record only the
 * handful of primitives that actually changed — which is why the failure
 * looked partial rather than total.
 *
 * Hand-rolled rather than pulled from a dependency: `isShallowEqual`
 * (`packages/common/src/utils.ts`) is one level deep and would still compare
 * `points`' inner arrays by reference, and the only deep-equality packages in
 * the tree are `lodash.debounce`/`lodash.throttle`, neither of which is
 * `isEqual`. Adding one for twenty lines of structural walk would be a new
 * runtime dependency on the critical path of every board open.
 *
 * Deliberately structural, not `JSON.stringify` on both sides: stringify is
 * order-sensitive, so a live `boundElements` entry whose keys were built in a
 * different order from the stored one would read as a change nobody made.
 */
const holdsSameValue = (recorded: unknown, current: unknown): boolean => {
  if (recorded === current) {
    return true;
  }
  // NaN never equals itself, and `Number.isNaN` is the only way to say so.
  // A degenerate coordinate is not evidence of a collaborator's edit.
  if (typeof recorded === "number" && typeof current === "number") {
    return Number.isNaN(recorded) && Number.isNaN(current);
  }
  if (recorded === null || current === null) {
    return false;
  }
  if (typeof recorded !== "object" || typeof current !== "object") {
    return false;
  }

  if (Array.isArray(recorded) || Array.isArray(current)) {
    return (
      Array.isArray(recorded) &&
      Array.isArray(current) &&
      recorded.length === current.length &&
      recorded.every((value, index) => holdsSameValue(value, current[index]))
    );
  }

  const recordedEntries = Object.entries(recorded as ElementLike);
  const currentKeys = Object.keys(current as ElementLike);

  return (
    recordedEntries.length === currentKeys.length &&
    recordedEntries.every(
      ([key, value]) =>
        key in (current as ElementLike) &&
        holdsSameValue(value, (current as ElementLike)[key]),
    )
  );
};

/**
 * Whether `current` still holds every non-bookkeeping value in `recorded`.
 */
const holdsRecordedValues = (
  recorded: ElementLike,
  current: ElementLike,
): boolean =>
  Object.entries(recorded).every(
    ([key, value]) =>
      BOOKKEEPING_KEYS.has(key) || holdsSameValue(value, current[key]),
  );

/**
 * Which side of a `Delta` describes "what the scene should currently hold".
 *
 * `HistoryDelta` is built by inverting the forward change that produced it
 * (`ElementsDelta.inverse`, `packages/element/src/delta.ts`): the forward
 * delta's `inserted` — the state the edit left behind — becomes the
 * inverse's `deleted`, and the forward `deleted` — the state before the edit
 * — becomes the inverse's `inserted`, the target an undo is heading *to*.
 * So on a `HistoryDelta` sitting on the undo stack, `deleted` is the
 * precondition: what the original edit actually left in the scene, and what
 * must still be there for this entry to be safe to apply. `inserted` is only
 * where undoing it would take the scene next.
 *
 * Comparing against `inserted` instead — as a first pass at this function
 * did — checks the wrong side of that swap. It fails on exactly the
 * uncontroversial case this module exists to allow: an entry recorded
 * against still-current state gets rejected as though the precondition
 * itself no longer held, because `inserted` here is the value the entry is
 * moving *away from* the scene, not toward it.
 */
const preconditionOf = (change: PropertyChange): ElementLike => change.deleted;

/**
 * Whether every element `delta` touches still matches the state the delta
 * was recorded against.
 *
 * `updated` entries are pure property edits: the element has to already
 * exist for there to be anything to compare, so a missing element is
 * unambiguous staleness — nothing else could have left it in that state
 * without also touching the very properties this entry cares about.
 *
 * `added` and `removed` are different: they toggle *existence*, not just
 * properties. `removed` undoes a creation (it wants to mark the element
 * deleted again); `added` undoes a deletion (it wants to bring one back).
 * For both, the element being entirely absent from the current scene is not
 * evidence that somebody edited it — it can equally mean the outcome this
 * entry is chasing (deleted, or never-restored) already holds, with nothing
 * present for it to have clobbered on the way there. Rejecting on absence
 * unconditionally, as a first pass at this function did, would make an
 * undo-of-creation permanently unusable the moment its target's tombstone is
 * garbage-collected — for a scene that was never actually in conflict.
 * Presence is therefore only *checked* when there is something present to
 * check: if the id is live, its properties still have to match what this
 * entry recorded, which is what protects against a colleague who resurrected
 * or kept editing that same id.
 *
 * This is the per-property form of the compare-and-swap in invariant 2: the
 * scene-level `rev` guards a whole write, and this guards one entry against
 * the specific properties it is about to overwrite.
 */
export const isEntryApplicable = (
  delta: HistoryDelta,
  elements: ReadonlyMap<string, ElementLike>,
): boolean => {
  for (const [id, change] of Object.entries(
    delta.elements.updated as DeltaGroup,
  )) {
    const element = elements.get(id);
    if (!element || !holdsRecordedValues(preconditionOf(change), element)) {
      return false;
    }
  }

  const existenceToggles = [
    delta.elements.added as DeltaGroup,
    delta.elements.removed as DeltaGroup,
  ];

  for (const group of existenceToggles) {
    for (const [id, change] of Object.entries(group)) {
      const element = elements.get(id);
      if (element && !holdsRecordedValues(preconditionOf(change), element)) {
        return false;
      }
    }
  }

  return true;
};
