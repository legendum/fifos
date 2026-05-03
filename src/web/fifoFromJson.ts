import type { FifoEntry } from "./types";

/** Response body from `GET /:slug.json`. */
export type FifoDetailJson = {
  name: string;
  slug: string;
  ulid: string;
  counts?: { open: number; lock: number; done: number; fail: number };
  items?: unknown[];
};

/** Map a `/:slug.json` response into the FifoEntry row shape used by the home list. */
export function fifoFromDetailJson(data: FifoDetailJson): FifoEntry {
  return {
    name: data.name,
    slug: data.slug,
    ulid: data.ulid,
    position: 0,
    counts: data.counts ?? { open: 0, lock: 0, done: 0, fail: 0 },
    created_at: 0,
  };
}
