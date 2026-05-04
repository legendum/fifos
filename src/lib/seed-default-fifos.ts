import { getDb } from "./db.js";
import { toSlug, validateFifoName } from "./fifos.js";
import { push } from "./queue.js";
import { ulid } from "./ulid.js";
import { DEFAULT_FIFO_MAX_RETRIES } from "./web_constants.js";

const DEFAULT_FIFO_NAME = "My first FIFO";

/** Short welcome item (todos seeds starter lines; FIFO has one todo to try the UI / CLI). */
const WELCOME_ITEM_BODY =
  "Welcome! Add work from the + button or the fifos CLI.";

/**
 * Insert a starter fifo (+ one todo) for a newly created user.
 * Does not run billing — same idea as todos' `seedDefaultListsForNewUser`.
 */
export function seedDefaultFifosForNewUser(userId: number): void {
  const name = DEFAULT_FIFO_NAME;
  const nameErr = validateFifoName(name);
  if (nameErr) {
    console.error("seedDefaultFifosForNewUser: invalid default name", nameErr);
    return;
  }

  const slug = toSlug(name);
  const db = getDb();
  const maxPosRow = db
    .query(
      "SELECT COALESCE(MAX(position), -1) AS max_pos FROM fifos WHERE user_id = ?",
    )
    .get(userId) as { max_pos: number };
  const position = maxPosRow.max_pos + 1;
  const fifoUlid = ulid();

  db.run(
    "INSERT INTO fifos (user_id, ulid, name, slug, position, max_retries) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    fifoUlid,
    name,
    slug,
    position,
    DEFAULT_FIFO_MAX_RETRIES,
  );

  const row = db
    .query("SELECT id FROM fifos WHERE user_id = ? AND slug = ?")
    .get(userId, slug) as { id: number } | undefined;
  if (!row) {
    console.error("seedDefaultFifosForNewUser: fifo row missing after insert");
    return;
  }

  const pushed = push(row.id, WELCOME_ITEM_BODY, null);
  if (!pushed) {
    console.error("seedDefaultFifosForNewUser: push failed (fifo full?)");
  }
}
