/**
 * `<RenameTitle>` — click-to-edit title that performs the optimistic
 * rename dance via `useRename`.
 *
 * Renders as a button showing the label; click → input; Enter saves,
 * Escape cancels, blur saves. Drop into `<ObjectDetail>`'s `title` slot
 * when inline rename is wanted. Consumers that prefer a modal dialog
 * (fifos' `EditTextDialog` pattern) can pass a different title content
 * to `<ObjectDetail>` and call `useRename` directly.
 *
 * The `className` prop is appended to the root element (button or input)
 * so consumers can apply their existing title styling (font, color,
 * size) without overriding pues' default chrome.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useRename } from "./useRename";
import type { UseResourceResult } from "./useResource";

export type RenameTitleProps<TExtra = Record<string, unknown>> = {
  resource: UseResourceResult<TExtra>;
  /** Route segment passed to `useRename`. */
  resourceName: string;
  /** Defaults to "/api". Should match `useResource`'s basePath. */
  basePath?: string;
  /** Public id of the row being renamed. */
  rowId: string | number;
  /** Current label. */
  label: string;
  /** Extra class appended to the rendered button/input. Use to apply
   *  consumer-specific font/color/size — pues' own default class
   *  (`pues-rename-title`) is always present too. */
  className?: string;
};

export function RenameTitle<TExtra = Record<string, unknown>>({
  resource,
  resourceName,
  basePath,
  rowId,
  label,
  className,
}: RenameTitleProps<TExtra>) {
  const { rename } = useRename({ resource, resourceName, basePath });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  // Track the underlying label when not editing (e.g. external rename
  // via SSE, or switching to a different row).
  useEffect(() => {
    if (!editing) setDraft(label);
  }, [label, editing]);

  // Focus + select when entering edit mode.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    setDraft(label);
    setEditing(true);
  }, [label]);

  const cancelEdit = useCallback(() => {
    setDraft(label);
    setEditing(false);
  }, [label]);

  const saveEdit = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === label) {
      cancelEdit();
      return;
    }
    setEditing(false);
    await rename(rowId, trimmed);
  }, [draft, label, rowId, rename, cancelEdit]);

  const cls = className
    ? `pues-rename-title ${className}`
    : "pues-rename-title";

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={cls}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void saveEdit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void saveEdit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
          }
        }}
        aria-label="Rename"
      />
    );
  }

  return (
    <button
      type="button"
      className={cls}
      onClick={startEdit}
      title="Click to rename"
    >
      {label}
    </button>
  );
}
