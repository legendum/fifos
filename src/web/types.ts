export type StatusCounts = {
  todo: number;
  lock: number;
  done: number;
  fail: number;
  skip: number;
};

export type FifoEntry = {
  name: string;
  slug: string;
  ulid: string;
  position: number;
  counts: StatusCounts;
  created_at: number;
};

export type ItemStatus = "todo" | "lock" | "done" | "fail" | "skip";

export type Item = {
  id: string;
  position: number;
  status: ItemStatus;
  data: string;
  locked_until: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
};
