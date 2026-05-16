/**
 * Controlled filter input — the UI half of pues' filter feature.
 * Pair with `useFilter` for the filtering logic; this component is pure
 * input chrome.
 *
 * Renders: search icon + `<input type="search">` + clear (×) button when
 * the query is non-empty. Escape clears the query when one is set.
 *
 * State stays with the caller (so the same query can drive a home list and
 * a detail page). Forward a ref via `inputRef` to handle focus management
 * (e.g. "focus the filter when returning to the home list").
 */

import type { RefObject } from "react";

export type FilterBarProps = {
  query: string;
  setQuery: (q: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  ariaLabel?: string;
  /** DOM id for the `<input>`. Set if the consumer wants its own label
   * association; otherwise the wrapper `<label>` already covers click-to-focus. */
  id?: string;
  /** Extra class names appended to the root `<label>`. Useful for layout
   * (e.g. `flex: 1` inside a top bar). pues styling lives on
   * `.pues-filter-bar` regardless. */
  className?: string;
};

export function FilterBar({
  query,
  setQuery,
  inputRef,
  placeholder = "Filter…",
  ariaLabel = "Filter",
  id,
  className,
}: FilterBarProps) {
  const rootClass = className
    ? `pues-filter-bar ${className}`
    : "pues-filter-bar";
  return (
    <label
      className={rootClass}
      htmlFor={id}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="pues-filter-bar-icon" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path
            d="M20 20l-3-3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input
        ref={inputRef}
        id={id}
        type="search"
        className="pues-filter-bar-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            setQuery("");
            e.stopPropagation();
          }
        }}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        enterKeyHint="search"
      />
      {query ? (
        <button
          type="button"
          className="pues-filter-bar-clear"
          onClick={() => setQuery("")}
          aria-label="Clear filter"
        >
          ×
        </button>
      ) : null}
    </label>
  );
}
