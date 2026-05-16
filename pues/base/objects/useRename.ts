/**
 * `useRename` — the optimistic-mutate + PATCH + rollback dance that's
 * duplicated across consumers (todos' `Lists.tsx:saveRename`, fifos'
 * rename path, future detail pages via `<ObjectDetail>`).
 *
 * Sends `PATCH ${basePath}/${resourceName}/${rowId}` with
 * `X-Op-Id: <opId>` and body `{ label }`. The originating tab drops its
 * own echo (SPEC §7.2), so this hook also replaces the optimistic row
 * with the server-blessed response — that's what carries the new
 * `slug` (and any other server-derived passthroughs) back into
 * `resource.rows`. Without this final replacement, slug-derived URLs
 * would remain stale in the originating tab until an external event
 * re-broadcast the row.
 */

import { useCallback } from "react";

import type { Row, UseResourceResult } from "./useResource";

export type UseRenameOptions = {
  resource: UseResourceResult;
  /** Route segment, e.g. "lists" — used to build the PATCH URL. */
  resourceName: string;
  /** Defaults to "/api". Must match the `useResource` basePath. */
  basePath?: string;
};

export type RenameOutcome = { ok: true; row: Row | null } | { ok: false };

export type UseRenameResult = {
  /**
   * Rename a row. Trims whitespace; rejects empty strings.
   * On success: rows updated optimistically, then replaced with the
   * server response (so the new slug propagates). On failure: rolls
   * back to the pre-call snapshot.
   */
  rename: (rowId: string | number, newLabel: string) => Promise<RenameOutcome>;
};

export function useRename({
  resource,
  resourceName,
  basePath = "/api",
}: UseRenameOptions): UseRenameResult {
  const rename = useCallback(
    async (
      rowId: string | number,
      newLabel: string,
    ): Promise<RenameOutcome> => {
      const trimmed = newLabel.trim();
      if (!trimmed) return { ok: false };

      const opId = resource.newOpId();
      const snapshot = resource.rows;

      // Optimistic: update the label immediately. The slug (if any) is
      // still old here — the server-blessed row replaces this below.
      resource.mutate((prev) =>
        prev.map((r) => (r.id === rowId ? { ...r, label: trimmed } : r)),
      );

      const res = await fetch(
        `${basePath}/${resourceName}/${encodeURIComponent(String(rowId))}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Op-Id": opId,
          },
          body: JSON.stringify({ label: trimmed }),
        },
      );

      if (!res.ok) {
        resource.mutate(snapshot);
        return { ok: false };
      }

      let row: Row | null = null;
      try {
        const parsed = (await res.json()) as unknown;
        if (parsed && typeof parsed === "object" && "id" in parsed) {
          row = parsed as Row;
        }
      } catch {
        // Non-JSON response (or empty). Leave the optimistic state in
        // place — the label is right; only slug/timestamps may be stale.
      }

      if (row) {
        const serverRow = row;
        resource.mutate((prev) =>
          prev.map((r) => (r.id === rowId ? serverRow : r)),
        );
      }

      return { ok: true, row };
    },
    [resource, resourceName, basePath],
  );

  return { rename };
}
