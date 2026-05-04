import { DEFAULT_FIFO_MAX_RETRIES } from "../lib/web_constants.js";
import type { FifoEntry } from "./types";

/** Response body from `GET /:slug.json`. */
export type FifoDetailJson = {
  name: string;
  slug: string;
  ulid: string;
  max_retries?: number;
  counts?: {
    todo: number;
    lock: number;
    done: number;
    fail: number;
    skip: number;
  };
  items?: unknown[];
};

/** Map a `/:slug.json` response into the FifoEntry row shape used by the home list. */
export function fifoFromDetailJson(data: FifoDetailJson): FifoEntry {
  return {
    name: data.name,
    slug: data.slug,
    ulid: data.ulid,
    position: 0,
    max_retries: data.max_retries ?? DEFAULT_FIFO_MAX_RETRIES,
    counts: data.counts ?? { todo: 0, lock: 0, done: 0, fail: 0, skip: 0 },
    created_at: 0,
  };
}
