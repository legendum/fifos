We are creating a small ecosystem of super-useful AI-friendly tools,
for example ../todos repo which includes a "todos" CLI that talks to
webhooks via env vars set up in .env

This project is called fifos (for first-in-first-out queues).

It will be based on ../todos as a general template, except for the following
differences:

1) CLI is called "fifos" not "todos"
2) Schema will include "users" "fifos" and "items"
3) I'd like to copy the "todos" webhook model for each FIFO we make
4) Instead of showing a single markdown text like we do for "todos" we will list "items" in chrono order
5) there will be a filter at the top, just like for "todos"
6) The CLI "fifos" will have the following command format:

   fifos push "data"
   echo data | fifos push
   fifos pop
   fifos pop --block # wait until an item is ready (via polling or SSE?)
   fifos peek --items=5
   fifos pull # pop with lock
   fifos ack  # ack the pulled item
   fifos nack # nack the pulled item
   fifos info # return fifo name, how many items are in the fifo, etc
   fifos list done --items=5
   fifos list fail --items=5
   fifos list open --items=5
   fifos list lock

7) Status. I believe items should have a status, e.g. "open", "lock", "done", "fail"

8) Items in "done" and "fail" states should be purged periodically

This is intended to give AIs and humans a super easy way to manage FIFO work
queues. The format of the items can be anything, but will typically be JSON,
Markdown or YAML. We don't really care.

9) The UI will look and feel very similar to the "todos" UI, e.g. click the logo
top left to see instructions to install the "fifos" CLI, and click to copy a
FIFO webhook (shown below the FIFO name). We won't have undo/redo of course.
Instead we may include a status filter for open/lock/done/fail
