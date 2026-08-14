# 0019 — Undo survives closing the tab

**Status:** accepted. **Adds two additive entries to already-diverged files, plus one new test path — taking `packages/` divergence from 13 to 14. See invariant 10 and the accounting below.**

**Affects:** `packages/excalidraw/types.ts` (additive), `packages/excalidraw/components/App.tsx` (additive), `packages/excalidraw/tests/historyApi.test.tsx` (new); `excalidraw-app/data/undoHistory/{serialise,cap,staleness,store,index}.ts` (new, outside `packages/`) and their tests under `excalidraw-app/tests/`.

## Context

Excalidraw's `History` is a plain class field on `App` — `private history: History`, constructed with `new History(this.store)` (`App.tsx:647`, `:881`, `:889`) — and it keeps `undoStack`/`redoStack` as in-memory arrays and nothing else. Nothing ever wrote them anywhere. Close the tab, refresh, or navigate away and back, and both stacks are gone: not cleared, just never written down in the first place, because there was never a place for them to be written to.

On Lawha this hurts more than it would on a document you keep open. Boards are shared, sessions are short and interrupted — someone opens a board, makes a change, gets pulled away, and comes back an hour or a day later to find undo starts from nothing. The work is still on the board; the ability to walk it back one step at a time is not. That gap between "the change is there" and "I can undo the change" is what this ADR closes: a bounded number of undo steps now survive leaving a board and coming back to it, in the same browser.

Undo's behaviour does not change. Only its lifetime does.

## Only your own changes are undoable — and that rule is kept, not reversed

`packages/element/src/store.ts:51` documents `CaptureUpdateAction.NEVER`:

> "Use for updates which should never be recorded, such as remote updates or scene initialization."

Every change that arrives over the wire from a collaborator is dispatched with `NEVER`. It touches the scene, but it never touches `history.undoStack`. That is not an incidental property of how collaboration happens to be wired — it is the entire reason pressing undo on your own board only ever reverts things you did. Recording remote deltas would be a different feature: a shared, board-wide undo, where pressing the button could revert a change a colleague made in the last second, on the machine sitting next to yours, with no confirmation and no way to tell whose edit was just erased.

This feature persists exactly what `History` already scopes to "yours" — it changes where that stack lives, never what goes into it. Nothing here touches `store.ts`, and nothing here needed to: persisting `undoStack` after the fact inherits the own-changes-only guarantee for free, because the stack it persists was already filtered by the time it gets there. Reversing `store.ts:51` would need its own design and its own ADR, and § 1 above rules it out explicitly, on purpose, rather than by omission.

## History never leaves the browser

The persisted stack is written to a new `idb-keyval` store (`lawha-undo-history`), keyed `${userId}:${boardId}`, and read back the same way. No server route serves it, no fetch sends it, no socket message carries it — the same three checks ADR 0016 already applies to page views apply here by construction, because the code that would need to exist to violate it was never written.

**What that buys:** a board's undo history is not one more thing an administrator, a database compromise, or a monitoring tool could ever see. `resolveBoardPermission` and the rest of the server-side access model (invariant 21) have nothing to say about it, because there is nothing on the server for them to gate.

**What that costs:** the history does not follow you. Switch browsers, switch devices, or open the board in a private window, and you start from an empty undo stack — indistinguishable from today's behaviour, but now the difference between "your usual browser" and "anywhere else" is visible for the first time. The spec's design doc calls this settled, not incidental (§1): a cross-device or server-synced history was considered and rejected, because it would mean the history has to travel somewhere, and "somewhere" is a place `resolveBoardPermission` cannot protect once it is at rest off the machine that made it.

There is a second, sharper cost the design doc names directly as Risk 4: **deleted content lives on.** An undo entry that restores something you deleted is, by construction, a record of that deleted thing, sitting in IndexedDB until the cap trims it or the entries are cleared. On a personal machine this is unremarkable — it is exactly what undo already implies while the tab stays open. On a shared machine, where nobody reliably signs out, "I deleted it" no longer means "it's gone" for as long as the entry survives the cap. `clearHistoryForUser`, called on sign-out (`excalidraw-app/data/undoHistory/store.ts`), is the mitigation, not a fix: it depends on the person signing out, and a shared machine is exactly the case where people don't.

## The cap is a behaviour change, not a formality

Two limits apply, whichever is reached first:

- **50 entries.**
- **2,000,000 bytes** (`MAX_UNDO_BYTES`) per board, measured on the serialised stack.

`capHistory` (`excalidraw-app/data/undoHistory/cap.ts`) walks the stack from the newest entry backwards, keeping what fits and dropping the oldest first — undo walks backwards from the end, so trimming the tail preserves the steps someone is about to press undo for and discards the ones they would never have reached anyway. The newest entry is kept unconditionally even if it alone exceeds the byte budget: returning an empty history because the last thing you did was one large paste would make the most recent action the one thing you cannot undo, which is backwards from what a budget is for.

This is worth stating plainly rather than letting it read as a footnote: **`history.ts:125` (`this.undoStack.push(historyDelta);`) has never trimmed anything.** The in-memory stack Excalidraw ships with today is unbounded — a long, uninterrupted session can walk back as far as memory allows, with no cap at all. Persisting the stack introduces the first cap this history has ever had. A marathon session that today can undo forty, sixty, a hundred steps back will, once persisted, be trimmed to at most fifty entries or 2 MB the moment it round-trips through storage. That is a real regression for that session, not a hypothetical one, and it is accepted deliberately: the alternative is an IndexedDB store with no ceiling, growing for as long as a board stays open across visits, which is a worse failure mode because it fails silently and only shows up as "the browser is slow" months later. Bounding it now, and writing down that the bound is new, is cheaper than discovering the absence of a bound the hard way.

## Why the byte budget is measured in UTF-8 bytes, not `String.length`

`byteLength` in `cap.ts` is:

```ts
const byteLength = (entry: SerialisedDelta): number =>
  new TextEncoder().encode(JSON.stringify(entry)).byteLength;
```

not `JSON.stringify(entry).length`. This was not the first version shipped — it is a fix (commit `7fbb305`) for a real defect a review caught in the original implementation, and it is worth recording why the obvious version is wrong rather than just noting that it changed.

`.length` on a JS string counts UTF-16 code units. `MAX_UNDO_BYTES` is a budget on what actually lands in IndexedDB, which is UTF-8. For ASCII the two measures happen to agree, one code unit per byte, and that is exactly what let the mistake ship and pass its own test suite — every test built from `"x".repeat(n)` is ASCII and cannot tell the two measurements apart. **Lawha is an Arabic-named product** — لوحة, "board" — and Arabic board content is not a hypothetical: most Arabic-script characters (U+0600–U+06FF) are one UTF-16 code unit each, exactly like ASCII, but encode to **two** bytes in UTF-8, not one. A stack of Arabic text measured with `.length` at "2,000,000" could occupy close to double that on disk — `MAX_UNDO_BYTES` would be bounding a number that has nothing to do with the bytes it claims to bound, and it would be silently wrong in exactly the deployments where undo history is most likely to be full of the content the name of the product describes. `TextEncoder` is the same tool `FileManager.ts` already uses for `FILE_UPLOAD_MAX_BYTES`, so this is Lawha's existing convention for a byte budget, not a new one.

## The staleness rule: skip, never revert

Before an entry is applied, `isEntryApplicable` (`excalidraw-app/data/undoHistory/staleness.ts`) checks whether the scene still holds the values that entry recorded. If a collaborator has since changed the same properties on the same element, the entry is **skipped**, not applied — the stack advances past it rather than forcing the scene back to a state that no longer reflects what is actually there.

Skipping was chosen over the alternative — applying the entry anyway — because applying it would mean pressing your own undo button silently discards a colleague's edit that landed while you were away, with no warning to either of you. That is a strictly worse failure than "undo did less than expected": one degrades gracefully into a slightly confusing but harmless no-op, the other corrupts someone else's work without either party knowing it happened. This is the per-property form of the compare-and-swap discipline invariant 2 already applies at the whole-scene level (the server-owned monotonic `rev`, never last-write-wins on `sceneVersion`) — here the precondition is checked per property, against a stack entry that is applied entirely client-side and has no server round trip to reject it if the precondition is stale.

**What is actually compared, and why it took two corrections to get right:**

A `HistoryDelta` sitting on the undo stack is the _inverse_ of the change that produced it (`ElementsDelta.inverse`, `packages/element/src/delta.ts`): the forward edit's `inserted` — what the edit left in the scene — becomes the inverse's `deleted`, and the forward edit's `deleted` — what the scene held before — becomes the inverse's `inserted`, the target undo is heading toward. So on the entry `isEntryApplicable` receives, **`change.deleted` is the precondition**: what the original edit actually left in the scene, and what must still be true for the entry to be safe to apply. `change.inserted` is only where applying it would take the scene next. `preconditionOf` in `staleness.ts` returns `change.deleted` for exactly this reason — an earlier version of this check compared `inserted` instead, which gets the direction backwards and rejects the uncontroversial case (an entry recorded against still-current state) as though its own precondition no longer held.

`version` and `versionNonce` are excluded from the comparison. Every mutation of an element — including one that touches a completely unrelated property — bumps both, because `ElementsDelta.calculate` uses a changed `versionNonce` as its own signal that "something changed" (`delta.ts:1233`). Comparing them naively would mean a colleague recolouring an element invalidates an unrelated, already-safe undo of that element's position, purely because the version counter moved. `HistoryDelta.applyTo` already treats these two the same way, for the same reason — `excludedProperties: new Set(["version", "versionNonce"])` (`packages/excalidraw/history.ts:33`) — and the staleness check has to agree with that set or the two would disagree about what "the same element" means: `applyTo` would happily apply an entry that `isEntryApplicable` should have called stale, or vice versa.

One more distinction, smaller but load-bearing: entries that toggle an element's _existence_ (`added`/`removed` — undo of a deletion, undo of a creation) treat a missing element as **not** automatically stale, where entries that only edit properties (`updated`) do. An undo-of-creation's target element being absent from the current scene is not evidence someone touched it — it can just as easily mean the tombstone was already garbage-collected with nothing in conflict. Rejecting on absence unconditionally, tried first, made an undo-of-creation permanently unusable the moment its target's tombstone aged out, for a board that was never actually in conflict.

## The `packages/` accounting

Invariant 10 caps `packages/` divergence, on the reasoning stated in the invariants and reaffirmed in ADR 0013: the cap is what keeps an upstream merge tractable, and every path added is a decision to slow that down deliberately. The measured count before this feature was 13 (ADR 0013 took it from nine to thirteen; nothing since has changed it).

This feature needed a read and a hydrate on `ExcalidrawImperativeAPI.history`, which today exposes only `clear` (`types.ts:1241`). Both additions are **additive entries in files that were already diverged**:

- `packages/excalidraw/types.ts` — `getUndoStack` and `restoreUndoStack` alongside the existing `clear`, typed via the same `InstanceType<typeof App>[...]` indexed-access pattern `clear` already uses.
- `packages/excalidraw/components/App.tsx` — the two corresponding methods, declared next to `resetHistory` as private class properties, and two lines added to the existing API-assembly block at the `history:` object.

Neither is a new path. What is new is `packages/excalidraw/tests/historyApi.test.tsx`, the test written to pin this behaviour — and that **is** a new path, which is why the count moves from **13 to 14**, not "stays at 13" as an earlier draft of this accounting assumed before the test file existed. `git diff --stat $(git merge-base upstream/master main)..main -- packages/` confirms 14 changed paths as of this commit.

**A new test path is acceptable where a new source path would not be, and the difference is not a technicality.** Invariant 10 exists to bound what an upstream merge has to reconcile — and a merge reconciles _source_, because that is what upstream also edits. A test file that upstream Excalidraw does not have cannot conflict with anything upstream does, on any future merge, for as long as upstream never creates a file at that same path. `historyApi.test.tsx` lives beside the source it tests (`packages/excalidraw/tests/`), the same placement `clients.test.ts` already uses and the same reasoning ADR 0013 gives for `appPan.test.ts` and `rightDragPan.test.tsx`: a test that has to reach across the package boundary to find its subject gets deleted by the next person tidying up, and a test file cannot itself be the site of a merge conflict that costs anything beyond a possible name collision. The two _source_ edits — `types.ts` and `App.tsx` — are the ones invariant 10 is actually protecting against growing, and both stayed at zero new paths: additive lines in files the merge already has to look at regardless of this feature.

## The encapsulation cost this leaves behind

`restoreUndoStack` (`App.tsx`) does this:

```ts
private restoreUndoStack = (deltas: readonly HistoryDelta[]) => {
  this.history.undoStack.length = 0;
  this.history.undoStack.push(...deltas);

  this.history.onHistoryChangedEmitter.trigger(
    new HistoryChangedEvent(
      this.history.isUndoStackEmpty,
      this.history.isRedoStackEmpty,
    ),
  );
};
```

It reaches directly into `History.undoStack` — a public field, but one `History`'s own methods (`record`, `perform`) always mutate through their own logic, never by truncating and re-pushing from outside — and then hand-replicates the `.trigger(new HistoryChangedEvent(...))` call that `record`/`perform` already do internally after touching either stack. This is not a hypothetical fragility: the first version of this method, written to the letter of the implementation plan, mutated `undoStack` and stopped there. It compiled, its type signature was correct, and `getUndoStack()` reported the right entries immediately afterward — but the undo button (`actions/actionHistory.tsx`, subscribed to `onHistoryChangedEmitter` via `useEmitter`) stayed disabled after a restore, because nothing had told it the stack changed. That is exactly the kind of failure this codebase's own house style warns about: a subsystem with no way to report what it did presents its failure as absence, and absence reads as "the feature doesn't work" rather than as the one missing line it actually was.

The fix — trigger the emitter by hand, with the same event shape `History` itself constructs — is correct and is tested (`historyApi.test.tsx` pins both the replace-not-append behaviour and the emitter trigger via mutation testing; see the Task 5 report for both mutations and their exact failures). It is also the wrong place for this logic to live. `History` owns `undoStack`, `redoStack`, and the invariant that every mutation of either is followed by a trigger; `App.tsx` now owns a second, independent copy of that invariant, enforced by hand, for exactly one call site. The two will only ever agree because someone remembered to keep them in sync — `history.ts` gaining a third way to mutate its own stacks without triggering would silently break `restoreUndoStack` again, with the same "disabled button" symptom, and nothing would fail loudly to say so.

This was not fixed here because `history.ts` was out of scope for the task that found it: the plan's stated `packages/` budget was exactly `types.ts` and `App.tsx`, and adding `history.ts` as a third touched file would have meant this ADR's accounting above reads 15, not 14, for a refactor that changes no observable behaviour. **The cleaner home for this is a `History.restoreUndoStack()` method**, added to `history.ts` itself, that owns both the mutation and the trigger the way `record`/`perform` already do — collapsing the two copies of the invariant back into one. That is a new `packages/` source path and a new decision, and it gets its own ADR if and when it happens; this one records the cost of not doing it yet, deliberately, rather than letting it go unrecorded.

## Consequences

- **Undo history now has a lifetime bound it never had before**: capped at 50 entries or 2 MB, cleared on sign-out, scoped per `${userId}:${boardId}` so one person on a shared machine never inherits another's undo entries (including content they deleted) after signing in.
- **A long session's undo depth is now bounded where it previously wasn't** (§ above) — accepted as the price of a storage layer with a known ceiling instead of an unbounded one that fails silently later.
- **Three real defects were caught and fixed during implementation, not anticipated by the design**: `deserialiseDelta` restoring through the wrong class (`StoreDelta` instead of `HistoryDelta`, which has no `applyTo`); the byte cap measuring UTF-16 code units instead of UTF-8 bytes; and the staleness check comparing the wrong side of the delta (`inserted` instead of `deleted`) plus treating `added`/`removed` absence too strictly and `version`/`versionNonce` too literally. Each is described above where it bears on the decision it corrects; none of them changes what this ADR decided, only what it takes to implement it correctly.
- **The feature's storage and API primitives exist as of this ADR; the board lifecycle is not yet wired to them.** Tasks 1–5 build `serialiseDelta`/`deserialiseDelta`, `capHistory`, `isEntryApplicable`, the IndexedDB store, and the imperative API surface this ADR documents. Reading history back on board open, writing it on `onHistoryChanged`, and clearing it on sign-out are follow-on work against `excalidraw-app/collab/Collab.tsx` and `useLawhaSession.ts`, tracked separately — this ADR is required now, at the point the `packages/` divergence was introduced, rather than deferred until that wiring lands.
- **Out of scope, on purpose, matching the design doc §9**: server-side or cross-device history, board-wide or shared history, undoing a collaborator's change, and persisted redo. Redo is not persisted at all — only the undo stack is written to IndexedDB; "I undid something and want it back" is a within-session intention, and persisting it would double the storage for a case nobody asked for.

---

## Amendment, 2026-08-06 — history expires after 30 days

A security review put the privacy argument above under load and it did not hold. `clearHistoryForUser` on sign-out was the whole mitigation, and sign-out is the one thing a shared machine never does. A browser nobody signs out of kept recoverable deleted content from every board indefinitely — and because the 2 MB cap is per board rather than per account, "bounded" was never bounded in aggregate: thirty boards meant up to sixty megabytes of it.

**Stored records now carry `writtenAt`, and `readHistory` discards anything older than `UNDO_HISTORY_MAX_AGE_MS` (30 days).** 30 because that is `LAWHA_SESSION_TTL_DAYS` here: the thing worth preventing is history outliving the session that produced it.

Three details that are decisions rather than mechanics:

**Enforced on read, not by a sweep.** A sweep needs something to run it, and the moment history is read is the only moment this code is certainly running.

**Unknown age reads as expired.** A record with no `writtenAt`, or a non-numeric one, is discarded. Keeping it because the field is missing would let content of unbounded age survive on the strength of an absent property, which is the opposite of what the bound is for. A record stamped in the future — a clock that moved backwards — is discarded on the same reasoning.

**`UNDO_HISTORY_SCHEMA` goes to 2**, so every record written before this lands is dropped rather than being treated as age-unknown. That costs everyone their current undo history once, which is exactly what the schema stamp is for.

This narrows the exposure; it does not remove it. Thirty days of deleted content is still thirty days, and the honest statement is that undo history is as private as the machine it is on.
