/**
 * Selection maths for the dashboard grid.
 *
 * Pure, and deliberately outside the component. The interesting behaviour here
 * is not the checkbox: it is what a shift-click means once the anchor has been
 * filtered off the screen, and what happens to a selection when the boards in
 * it stop being visible. Both are easier to get right — and to pin with a test
 * — as functions over a set of ids than as `useState` juggling inside a route
 * that is already doing five other things.
 *
 * Every operation returns a new set, with one deliberate exception:
 * `pruneSelection` returns the *same* set when nothing changed. That identity
 * is load-bearing — it is what stops the effect that prunes on every grid
 * change from setting state in a loop.
 */

/** The empty selection, shared so "nothing selected" is one stable reference. */
export const NO_SELECTION: ReadonlySet<string> = new Set<string>();

export const toggleSelected = (
  selected: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> => {
  const next = new Set(selected);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
};

/**
 * Shift-click: everything between the anchor and `id`, added to the selection.
 *
 * Additive rather than replacing, because replacing throws away a selection
 * someone assembled by hand the instant they shift-click once — and there is no
 * undo for a selection.
 *
 * Falls back to a plain toggle when there is no anchor yet, or when the anchor
 * has since left the grid. A range measured from a board that is no longer on
 * screen would select a span the user cannot see, which is the same hidden
 * state this whole module exists to avoid.
 */
export const selectRange = (
  selected: ReadonlySet<string>,
  orderedIds: readonly string[],
  anchorId: string | null,
  id: string,
): ReadonlySet<string> => {
  const from = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
  const to = orderedIds.indexOf(id);

  if (from < 0 || to < 0) {
    return toggleSelected(selected, id);
  }

  const next = new Set(selected);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  for (let index = start; index <= end; index++) {
    next.add(orderedIds[index]);
  }
  return next;
};

/**
 * Drops ids that are no longer on screen.
 *
 * The dashboard runs this whenever the grid changes, so "3 selected" always
 * means three boards you can point at. Without it, switching folder or typing
 * in the search field would leave Delete aimed at boards that had scrolled out
 * of existence — the worst possible hidden state for the one action with no way
 * back from it.
 *
 * Returns the input set unchanged when nothing was dropped; see the note at the
 * top of the file about why that matters.
 */
export const pruneSelection = (
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): ReadonlySet<string> => {
  if (selected.size === 0) {
    return selected;
  }

  const visible = new Set(visibleIds);
  const kept = [...selected].filter((id) => visible.has(id));

  return kept.length === selected.size ? selected : new Set(kept);
};

export const selectAll = (ids: readonly string[]): ReadonlySet<string> =>
  new Set(ids);

/**
 * True when every board on screen is selected.
 *
 * An empty grid is *not* "all selected": the select-all control would otherwise
 * read "Clear" while there is nothing to clear.
 */
export const isEverySelected = (
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): boolean =>
  visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
