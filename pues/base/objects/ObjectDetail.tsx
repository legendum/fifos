/**
 * `<ObjectDetail>` — pure layout shell for per-row detail pages.
 *
 * Three header slots — all `ReactNode`, all consumer-controlled:
 *   - `title`     — primary header content (drop in `<RenameTitle>` for
 *                   inline rename, or a plain string, or anything else)
 *   - `subtitle?` — small line directly below the title (the spot where
 *                   todos/fifos show a copy-link / shortened-ULID button)
 *   - `actions?`  — right-side header content (undo/redo, kebab, …)
 *
 * Plus `onBack` and body `children`. ObjectDetail ships no behavior —
 * not rename, not copy. It owns the **layout** (back-left / centered
 * stacked title+subtitle / actions-right) and nothing else. Behavior
 * primitives ship separately (`<RenameTitle>`, `useRename`) and consumers
 * compose them.
 */

import type { ReactNode } from "react";

const DEFAULT_BACK_GLYPH = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M15 18l-6-6 6-6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export type ObjectDetailProps = {
  onBack: () => void;
  /** Primary title content. Consumer composes this — pass a plain
   *  string, a `<RenameTitle>`, or any custom node. */
  title: ReactNode;
  /** Small line below the title. Common pattern: a copy-link button
   *  with the row's ULID. Consumer-owned entirely. */
  subtitle?: ReactNode;
  /** Right-side header content. */
  actions?: ReactNode;
  /** Body. */
  children: ReactNode;
  /** Optional extra class on the root element. */
  className?: string;
  /** Extra class appended to the `<header>` row. Use to apply
   *  consumer-specific header chrome (padding, border, gap). */
  headerClassName?: string;
  /** Content of the back button. Defaults to a chevron glyph; pass
   *  `"◀ Back"` (or any node) to use text or a custom icon instead. */
  backLabel?: ReactNode;
  /** Extra class appended to the back button. Use to apply
   *  consumer-specific button styling. */
  backClassName?: string;
};

export function ObjectDetail({
  onBack,
  title,
  subtitle,
  actions,
  children,
  className,
  headerClassName,
  backLabel,
  backClassName,
}: ObjectDetailProps) {
  const rootClass = className
    ? `pues-object-detail ${className}`
    : "pues-object-detail";
  const headerClass = headerClassName
    ? `pues-object-detail-header ${headerClassName}`
    : "pues-object-detail-header";
  const backClass = backClassName
    ? `pues-object-detail-back ${backClassName}`
    : "pues-object-detail-back";
  return (
    <div className={rootClass}>
      <header className={headerClass}>
        <button
          type="button"
          className={backClass}
          onClick={onBack}
          aria-label="Back"
        >
          {backLabel ?? DEFAULT_BACK_GLYPH}
        </button>
        <div className="pues-object-detail-center">
          <div className="pues-object-detail-title">{title}</div>
          {subtitle ? (
            <div className="pues-object-detail-subtitle">{subtitle}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="pues-object-detail-actions">{actions}</div>
        ) : null}
      </header>
      <div className="pues-object-detail-body">{children}</div>
    </div>
  );
}
