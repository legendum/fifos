export type StatusCounts = {
  open: number;
  lock: number;
  done: number;
  fail: number;
};

export type FifoEntry = {
  name: string;
  slug: string;
  ulid: string;
  position: number;
  counts: StatusCounts;
  created_at: number;
};

export type ItemStatus = "open" | "lock" | "done" | "fail";

export type Item = {
  id: string;
  position: number;
  status: ItemStatus;
  data: string;
  locked_until: number | null;
  fail_reason: string | null;
  created_at: number;
  updated_at: number;
};
