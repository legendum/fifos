/**
 * Client-side row filter — the logic half of pues' filter feature.
 * Pair with `<FilterBar>` (input chrome) or roll your own input.
 *
 * Predicate-only by design: no `fields:` shortcut, no row-shape coupling.
 * Each consumer decides what "match" means for its rows (case folding,
 * which fields, prefix vs substring). The hook handles trim/active
 * derivation and memoization; it stays opinion-free about row shape.
 */

import { useMemo } from "react";

export type FilterPredicate<T> = (row: T, query: string) => boolean;

export type UseFilterResult<T> = {
  active: boolean;
  visibleRows: T[];
};

/**
 * Pure filter step — exported for tests so the trim/active/predicate
 * semantics can be verified without React. The hook below wraps this in
 * `useMemo`.
 */
export function applyFilter<T>(
  rows: T[],
  query: string,
  predicate: FilterPredicate<T>,
): UseFilterResult<T> {
  const trimmed = query.trim();
  const active = trimmed.length > 0;
  return {
    active,
    visibleRows: active ? rows.filter((r) => predicate(r, trimmed)) : rows,
  };
}

/**
 * Predicate receives the trimmed (non-empty) query as a raw string —
 * predicate decides case sensitivity / normalization.
 *
 * Memoized on `[rows, query, predicate]`. Pass a stable predicate
 * (module-level function or `useCallback`) if your list is large or your
 * match logic is expensive; for typical home-list sizes (<1000 rows) the
 * recomputation cost of an inline predicate is negligible.
 */
export function useFilter<T>(
  rows: T[],
  query: string,
  predicate: FilterPredicate<T>,
): UseFilterResult<T> {
  return useMemo(
    () => applyFilter(rows, query, predicate),
    [rows, query, predicate],
  );
}
