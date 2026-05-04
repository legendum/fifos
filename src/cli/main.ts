#!/usr/bin/env bun

/**
 * fifos — stateless CLI. Every subcommand is a single webhook call.
 *
 * Resolution order for the target webhook URL:
 *   1. `-f` / `--fifo <ulid>` flag (per-call override — ULID only)
 *   2. `FIFOS_WEBHOOK` from the cwd `.env` (fifo ULID or legacy full webhook URL)
 *   3. Interactive TTY prompt → save canonical webhook URL to `.env`
 *   4. Error (exit 2) when stdin isn't a TTY
 *
 * Exit codes (SPEC §2.4): 0 success / 1 empty / 2 error.
 */

import { execSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { YAML } from "bun";

import { ITEM_STATUSES_PIPE, isItemStatus } from "../lib/web_constants.js";

const LOCK_FILE = ".fifos-lock";
// 26-char ULID, Crockford base32. First char is 0-7 (high 2 bits of a 48-bit
// ms timestamp are zero until ~year 10889).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

type Format = "text" | "json" | "yaml";

type Parsed = {
  fifoOverride: string | null;
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
};

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    fifoOverride: null,
    command: null,
    positional: [],
    flags: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--fifo") {
      out.fifoOverride = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        // Long flag: take next token as value if present and not another flag,
        // else treat as boolean.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          out.flags.set(a.slice(2), next);
          i++;
        } else {
          out.flags.set(a.slice(2), true);
        }
      }
    } else if (out.command === null) {
      out.command = a;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function getEnvWebhook(): string | null {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf-8").match(/^FIFOS_WEBHOOK=(.+)$/m);
  return m?.[1]?.trim() || null;
}

function saveEnvWebhook(url: string): void {
  const path = join(process.cwd(), ".env");
  let content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (/^FIFOS_WEBHOOK=/m.test(content)) {
    content = content.replace(/^FIFOS_WEBHOOK=.*$/m, `FIFOS_WEBHOOK=${url}`);
  } else {
    content += content && !content.endsWith("\n") ? "\n" : "";
    content += `FIFOS_WEBHOOK=${url}\n`;
  }
  writeFileSync(path, content);
}

function readLineSync(): string {
  const buf = Buffer.alloc(1024);
  const fd = openSync("/dev/tty", "r");
  const n = readSync(fd, buf, 0, 1024, null);
  closeSync(fd);
  return buf.toString("utf-8", 0, n).replace(/\r?\n$/, "");
}

/** Expand a fifo ULID to `${FIFOS_DOMAIN}/w/<ULID>` or null if invalid. */
function fifoUlidToWebhookBase(ulidStr: string): string | null {
  const s = ulidStr.trim();
  if (!ULID_RE.test(s)) return null;
  const domain = (process.env.FIFOS_DOMAIN || "https://fifos.dev").replace(
    /\/+$/,
    "",
  );
  return `${domain}/w/${s.toUpperCase()}`;
}

function requireFifoUlid(raw: string, ctx: string): string {
  const url = fifoUlidToWebhookBase(raw);
  if (!url) {
    console.error(
      `${ctx}: invalid fifo ULID (expect 26-character Crockford base32)`,
    );
    process.exit(2);
  }
  return url;
}

/** `.env` line: fifo ULID or a legacy full webhook URL from older setups. */
function webhookUrlFromEnvValue(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const fromUlid = fifoUlidToWebhookBase(s);
  if (fromUlid) return fromUlid;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  return null;
}

function resolveWebhookUrl(override: string | null): string {
  if (override) return requireFifoUlid(override, "-f / --fifo");
  const fromEnv = getEnvWebhook();
  if (fromEnv) {
    const url = webhookUrlFromEnvValue(fromEnv);
    if (!url) {
      console.error(
        "FIFOS_WEBHOOK in .env must be a fifo ULID or a webhook URL. Fix .env or pass -f <ulid>.",
      );
      process.exit(2);
    }
    return url;
  }
  if (!process.stdin.isTTY) {
    console.error(
      "FIFOS_WEBHOOK not set. Pass -f <ulid>, set FIFOS_WEBHOOK in .env, or run interactively for the first-run prompt.",
    );
    process.exit(2);
  }
  process.stdout.write("Enter your fifo ULID: ");
  const raw = readLineSync().trim();
  if (!raw) {
    console.error("No ULID provided.");
    process.exit(2);
  }
  const url = requireFifoUlid(raw, "Fifo ULID");
  saveEnvWebhook(url);
  return url;
}

type FetchResult = {
  status: number;
  body: string;
  headers: Headers;
};

async function request(
  baseUrl: string,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> {
  const url = `${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body: init.body,
      headers: init.headers,
    });
  } catch (err: any) {
    console.error(`Network error: ${err?.message ?? err}`);
    process.exit(2);
  }
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

function parseJSON(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function dieFromHttp(res: FetchResult): never {
  const j = parseJSON(res.body);
  const msg = j?.message || j?.error || res.body || `HTTP ${res.status}`;
  console.error(`Error (${res.status}): ${msg}`);
  process.exit(2);
}

function formatOutput(payload: unknown, format: Format): string {
  if (format === "json") return JSON.stringify(payload, null, 2);
  if (format === "yaml") {
    return YAML.stringify(payload, null, 2);
  }
  return formatText(payload);
}

function formatText(payload: any): string {
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.items)) {
      return payload.items.length
        ? payload.items
            .map((it: any) => {
              const head = `${String(it.position).padStart(4)}  ${it.status}  ${it.id}  ${truncate(
                it.data ?? "",
                80,
              )}`;
              return it.reason
                ? `${head}\n      ↳ ${truncate(it.reason, 100)}`
                : head;
            })
            .join("\n")
        : "(empty)";
    }
    if (payload.counts) {
      const c = payload.counts;
      const total = c.todo + c.lock + c.done + c.fail + c.skip;
      return [
        `fifo: ${payload.name}  (${payload.slug})`,
        `ulid: ${payload.ulid}`,
        `todo: ${c.todo}, lock: ${c.lock}, done: ${c.done}, fail: ${c.fail}, skip: ${c.skip}  (total: ${total})`,
      ].join("\n");
    }
    return JSON.stringify(payload);
  }
  return String(payload);
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function pickFormat(flags: Parsed["flags"]): Format {
  if (flags.has("json")) return "json";
  if (flags.has("yaml")) return "yaml";
  return "text";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ----- Commands -----

async function cmdPush(baseUrl: string, parsed: Parsed): Promise<number> {
  const key = parsed.flags.get("key");
  const fromArg = parsed.positional.join(" ");
  const data = fromArg || (await readStdin());
  if (!data) {
    console.error("push: no data (pass an arg or pipe via stdin)");
    return 2;
  }
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (typeof key === "string") headers["Idempotency-Key"] = key;
  const res = await request(baseUrl, "POST", "/push", {
    body: data,
    headers,
  });
  if (res.status !== 200 && res.status !== 201) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(j.id);
  return 0;
}

async function cmdPop(baseUrl: string, parsed: Parsed): Promise<number> {
  if (parsed.flags.has("block")) {
    return cmdPopBlock(baseUrl, parsed);
  }
  const res = await request(baseUrl, "POST", "/pop");
  if (res.status === 204) return 1;
  if (res.status !== 200) dieFromHttp(res);
  writeItemDataFromResponse(res);
  return 0;
}

function writeItemDataFromResponse(res: { body: string }): void {
  const j = parseJSON(res.body) ?? {};
  process.stdout.write(j.data ?? "");
  if (typeof j.data === "string" && !j.data.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function cmdPopBlock(baseUrl: string, parsed: Parsed): Promise<number> {
  return blockUntilItem(baseUrl, parsed, async () => {
    const r = await request(baseUrl, "POST", "/pop");
    if (r.status === 200) {
      writeItemDataFromResponse(r);
      return "got";
    }
    if (r.status === 204) return "empty";
    dieFromHttp(r);
  });
}

/**
 * Common block-and-retry loop for `pop --block` and `pull --block`. Tries
 * `attempt` once; if empty, subscribes to SSE and re-attempts on each
 * `push` event until success, timeout (exit 1), or hard error.
 */
async function blockUntilItem(
  baseUrl: string,
  parsed: Parsed,
  attempt: () => Promise<"got" | "empty">,
): Promise<number> {
  if ((await attempt()) === "got") return 0;

  const timeoutSec = parsed.flags.has("timeout")
    ? Number(parsed.flags.get("timeout"))
    : 0;
  const start = Date.now();
  const remainingMs = () =>
    timeoutSec > 0 ? timeoutSec * 1000 - (Date.now() - start) : Infinity;

  const lastEventId: { current: string | null } = { current: null };

  while (true) {
    if (remainingMs() <= 0) return 1;
    const outcome = await awaitNextPushEvent(baseUrl, remainingMs, lastEventId);
    if (outcome === "expired") return 1;
    if (outcome === "reconnect") continue;
    // got push — try again, then keep listening on a lost race
    if ((await attempt()) === "got") return 0;
  }
}

/**
 * Open one SSE connection to `/items` and resolve with the outcome:
 *   - "push"      a `push` event was seen (caller should re-attempt the action)
 *   - "expired"   the wait window elapsed before any push event
 *   - "reconnect" stream ended/blipped — caller should retry, optionally with
 *                 the updated `Last-Event-ID`
 */
type PushWaitOutcome = "push" | "expired" | "reconnect";

async function awaitNextPushEvent(
  baseUrl: string,
  remainingMs: () => number,
  lastEventId: { current: string | null },
): Promise<PushWaitOutcome> {
  const remaining = remainingMs();
  if (remaining <= 0) return "expired";

  const ac = new AbortController();
  const timer = Number.isFinite(remaining)
    ? setTimeout(() => ac.abort("timeout"), remaining)
    : null;

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId.current) headers["Last-Event-ID"] = lastEventId.current;

  let gotPush = false;
  try {
    const res = await fetch(`${baseUrl}/items`, {
      headers,
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 404) {
        dieFromHttp({
          status: res.status,
          body: await res.text(),
          headers: res.headers,
        });
      }
      await sleep(500);
      return "reconnect";
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    readLoop: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nlnl = buf.indexOf("\n\n");
      while (nlnl !== -1) {
        const block = buf.slice(0, nlnl);
        buf = buf.slice(nlnl + 2);
        nlnl = buf.indexOf("\n\n");
        const evt = parseSSEBlock(block);
        if (evt.id) lastEventId.current = evt.id;
        if (evt.event === "push") {
          gotPush = true;
          ac.abort();
          break readLoop;
        }
        // `change`/`resync`/keep-alive — ignore.
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" && !gotPush) {
      if (remainingMs() <= 0) return "expired";
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return gotPush ? "push" : "reconnect";
}

function parseSSEBlock(block: string): {
  event?: string;
  id?: string;
  data?: string;
} {
  const out: { event?: string; id?: string; data?: string } = {};
  for (const raw of block.split("\n")) {
    if (!raw || raw.startsWith(":")) continue;
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const field = raw.slice(0, idx);
    const value = raw.slice(idx + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "id") out.id = value;
    else if (field === "data") out.data = (out.data ?? "") + value;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdPull(baseUrl: string, parsed: Parsed): Promise<number> {
  const existing = readLockFile();
  if (existing) {
    process.stderr.write(
      `pull: .fifos-lock already holds ${existing} — finish it with 'fifos done|fail|skip' (or delete .fifos-lock to abandon) before pulling another\n`,
    );
    return 2;
  }
  if (parsed.flags.has("block")) {
    return cmdPullBlock(baseUrl, parsed);
  }
  const path = pullPath(parsed);
  const res = await request(baseUrl, "POST", path);
  if (res.status === 204) return 1;
  if (res.status !== 200) dieFromHttp(res);
  writePullResult(res);
  return 0;
}

async function cmdPullBlock(baseUrl: string, parsed: Parsed): Promise<number> {
  const path = pullPath(parsed);
  return blockUntilItem(baseUrl, parsed, async () => {
    const r = await request(baseUrl, "POST", path);
    if (r.status === 200) {
      writePullResult(r);
      return "got";
    }
    if (r.status === 204) return "empty";
    dieFromHttp(r);
  });
}

function pullPath(parsed: Parsed): string {
  const lock = parsed.flags.get("lock");
  return typeof lock === "string"
    ? `/pull?lock=${encodeURIComponent(lock)}`
    : "/pull";
}

function writePullResult(res: { body: string }): void {
  const j = parseJSON(res.body) ?? {};
  writeFileSync(join(process.cwd(), LOCK_FILE), `${j.id}\n`);
  process.stdout.write(j.data ?? "");
  if (typeof j.data === "string" && !j.data.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function readLockFile(): string | null {
  const path = join(process.cwd(), LOCK_FILE);
  if (!existsSync(path)) return null;
  const id = readFileSync(path, "utf-8").trim();
  return id || null;
}

function clearLockFile(): void {
  const path = join(process.cwd(), LOCK_FILE);
  if (existsSync(path)) unlinkSync(path);
}

// Optional reason: positional args take precedence; otherwise read stdin if
// it's a pipe (mirrors `push`). Empty body is valid — server stores NULL.
async function readReason(parsed: Parsed): Promise<string> {
  const fromArg = parsed.positional.join(" ");
  return fromArg || (await readStdin());
}

async function cmdDone(baseUrl: string, parsed: Parsed): Promise<number> {
  return finishLocked(baseUrl, "done", await readReason(parsed));
}
async function cmdFail(baseUrl: string, parsed: Parsed): Promise<number> {
  return finishLocked(baseUrl, "fail", await readReason(parsed));
}
async function cmdSkip(baseUrl: string, parsed: Parsed): Promise<number> {
  return finishLocked(baseUrl, "skip", await readReason(parsed));
}
async function finishLocked(
  baseUrl: string,
  verb: "done" | "fail" | "skip",
  body?: string,
): Promise<number> {
  const id = readLockFile();
  if (!id) {
    console.error(
      `${verb}: no .fifos-lock file in cwd (run 'fifos pull' first)`,
    );
    return 2;
  }
  const init: { body?: string; headers?: Record<string, string> } = {};
  if (body && body.length > 0) {
    init.body = body;
    init.headers = { "Content-Type": "text/plain; charset=utf-8" };
  }
  const res = await request(baseUrl, "POST", `/${verb}/${id}`, init);
  if (res.status === 200) {
    clearLockFile();
    return 0;
  }
  if (res.status === 404) {
    // Stale lock — server reclaimed it. Surface and clear so the user can re-pull.
    clearLockFile();
    console.error(
      `${verb}: lock expired or already finalized — cleared .fifos-lock`,
    );
    return 1;
  }
  dieFromHttp(res);
}

async function cmdStatus(baseUrl: string, parsed: Parsed): Promise<number> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("status: missing item ulid");
    return 2;
  }
  const res = await request(baseUrl, "GET", `/status/${id}`);
  if (res.status === 404) return 1;
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(formatOutput(j, pickFormat(parsed.flags)));
  return 0;
}

async function cmdRetry(baseUrl: string, parsed: Parsed): Promise<number> {
  const id = parsed.positional[0];
  if (!id) {
    console.error("retry: missing item ulid");
    return 2;
  }
  const res = await request(baseUrl, "POST", `/retry/${id}`);
  if (res.status === 404 || res.status === 409) return 1;
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(j.id);
  return 0;
}

async function cmdInfo(baseUrl: string, parsed: Parsed): Promise<number> {
  const res = await request(baseUrl, "GET", "/info", {
    headers: { Accept: "application/json" },
  });
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(formatOutput(j, pickFormat(parsed.flags)));
  return 0;
}

async function cmdPeek(baseUrl: string, parsed: Parsed): Promise<number> {
  const n = Number(parsed.flags.get("items") ?? 10);
  const res = await request(baseUrl, "GET", `/peek?n=${n}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(formatOutput(j, pickFormat(parsed.flags)));
  return 0;
}

async function cmdList(baseUrl: string, parsed: Parsed): Promise<number> {
  const status = parsed.positional[0];
  if (!status || !isItemStatus(status)) {
    console.error(`list: status must be one of ${ITEM_STATUSES_PIPE}`);
    return 2;
  }
  const n = Number(parsed.flags.get("items") ?? 10);
  const reason = parsed.flags.get("reason");
  let path = `/list/${status}?n=${n}`;
  if (typeof reason === "string" && reason.length > 0) {
    if (status !== "done" && status !== "fail" && status !== "skip") {
      console.error("list: --reason only applies to 'done', 'fail', or 'skip'");
      return 2;
    }
    path += `&reason=${encodeURIComponent(reason)}`;
  }
  const res = await request(baseUrl, "GET", path, {
    headers: { Accept: "application/json" },
  });
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  console.log(formatOutput(j, pickFormat(parsed.flags)));
  return 0;
}

async function cmdOpen(baseUrl: string): Promise<number> {
  const res = await request(baseUrl, "GET", "/info", {
    headers: { Accept: "application/json" },
  });
  if (res.status !== 200) dieFromHttp(res);
  const j = parseJSON(res.body) ?? {};
  const slug = j.slug;
  const origin = new URL(baseUrl).origin;
  const pageUrl = slug ? `${origin}/${encodeURIComponent(slug)}` : `${origin}/`;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execSync(`${opener} "${pageUrl}"`, { stdio: "ignore" });
  } catch {
    console.log(`Open: ${pageUrl}`);
  }
  return 0;
}

function cmdSkill(): number {
  const home = process.env.HOME || "~";
  const linkedRoot = join(home, ".config/fifos/src");
  const cliRepoRoot = dirname(dirname(__dirname));
  const sources = [
    join(linkedRoot, "config/SKILL.md"),
    join(cliRepoRoot, "config/SKILL.md"),
  ];
  const source = sources.find(existsSync);
  if (!source) {
    console.error(
      "Could not find config/SKILL.md (expected under ~/.config/fifos/src or next to the CLI).",
    );
    return 2;
  }
  const dests = [
    join(home, ".claude", "skills", "fifos", "SKILL.md"),
    join(home, ".cursor", "skills", "fifos", "SKILL.md"),
  ];
  for (const dest of dests) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    console.log(`  ${dest}`);
  }
  console.log("\nInstalled fifos skill for Claude Code and Cursor.");
  return 0;
}

function cmdHelp(): number {
  console.log(`fifos — push/pop/pull work items on a FIFO queue

Usage:
  fifos                          info
  fifos push "data"              push one item (or pipe via stdin)
  fifos push --key <s> "data"    idempotent push (1h dedupe)
  fifos pop                      pop oldest todo item (exit 1 if empty)
  fifos pop --block [--timeout N]  wait via SSE for a push, then pop
  fifos pull [--lock <dur>]      lock + write .fifos-lock (e.g. 600, 5m, 1h)
  fifos pull --block [--timeout N]  wait via SSE for a push, then pull
  fifos done [reason...]         mark the locked item done; optional one-line reason (positional or stdin, max 1 KiB)
  fifos fail [reason...]         mark it fail (retryable); same reason rules
  fifos skip [reason...]         mark it skip (terminal — retry refused); same reason rules
  fifos status <ulid>            one item's state
  fifos retry <ulid>             move done/fail back to todo at the tail (skip is terminal)
  fifos peek [--items=N]         oldest N todo items
  fifos info                     counts summary
  fifos list <todo|lock|done|fail|skip> [--items=N]
  fifos list <done|fail|skip> --reason <substr>      filter terminal items by case-insensitive substring of reason
  fifos open                     open this fifo's page in the browser
  fifos skill                    install agent skill for Claude / Cursor
  fifos help                     this message

Global:
  -f, --fifo <ulid>              override FIFOS_WEBHOOK for this call (fifo ULID only)
  --json | --yaml                JSON/YAML output for info/peek/list/status

Setup:
  Set FIFOS_WEBHOOK in .env (ULID or webhook URL; first interactive run saves the webhook URL).

Exit codes:
  0  success
  1  empty queue / not found / --block timeout
  2  error (network, auth, invalid usage)
`);
  return 0;
}

// ----- Dispatch -----

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const cmd = (parsed.command ?? "info").toLowerCase();

  if (cmd === "help" || parsed.flags.has("help") || parsed.flags.has("h")) {
    process.exit(cmdHelp());
  }
  if (cmd === "skill") process.exit(cmdSkill());

  const baseUrl = resolveWebhookUrl(parsed.fifoOverride);

  let code = 0;
  switch (cmd) {
    case "push":
      code = await cmdPush(baseUrl, parsed);
      break;
    case "pop":
      code = await cmdPop(baseUrl, parsed);
      break;
    case "pull":
      code = await cmdPull(baseUrl, parsed);
      break;
    case "done":
      code = await cmdDone(baseUrl, parsed);
      break;
    case "fail":
      code = await cmdFail(baseUrl, parsed);
      break;
    case "skip":
      code = await cmdSkip(baseUrl, parsed);
      break;
    case "status":
      code = await cmdStatus(baseUrl, parsed);
      break;
    case "retry":
      code = await cmdRetry(baseUrl, parsed);
      break;
    case "peek":
      code = await cmdPeek(baseUrl, parsed);
      break;
    case "info":
      code = await cmdInfo(baseUrl, parsed);
      break;
    case "list":
      code = await cmdList(baseUrl, parsed);
      break;
    case "open":
      code = await cmdOpen(baseUrl);
      break;
    default:
      console.error(`Unknown command: ${cmd}. Try 'fifos help'.`);
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(2);
});
