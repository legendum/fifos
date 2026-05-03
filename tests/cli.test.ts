import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB_PATH = "data/test-cli.db";
const PORT = 3043;

let server: { stop: () => void } | undefined;
let base: string;
let fifoUlid: string;
let cliEntry: string;
let workDir: string;

beforeAll(async () => {
  process.env.FIFOS_DB_PATH = TEST_DB_PATH;
  process.env.FIFOS_MAX_FIFOS_PER_USER = "3";
  process.env.FIFOS_MAX_ITEMS_PER_FIFO = "10";
  delete process.env.LEGENDUM_API_KEY;
  delete process.env.LEGENDUM_SECRET;

  mkdirSync("data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  const mod = await import("../src/api/server");
  server = Bun.serve({ ...mod.default, port: PORT });
  base = `http://localhost:${PORT}`;

  const create = await fetch(`${base}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cli-test" }),
  });
  const created = (await create.json()) as { ulid: string };
  fifoUlid = created.ulid;

  cliEntry = join(import.meta.dir, "../src/cli/main.ts");
  workDir = mkdtempSync(join(tmpdir(), "fifos-cli-"));
});

afterAll(async () => {
  server?.stop();
  const { closeDb } = await import("../src/lib/db");
  closeDb();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCli(
  args: string[],
  opts: { stdin?: string; cwd?: string; timeout?: number } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(
    ["bun", "run", cliEntry, "-f", fifoUlid, ...args],
    {
      cwd: opts.cwd ?? workDir,
      env: {
        ...process.env,
        FIFOS_DOMAIN: base,
      },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const timeout = opts.timeout ?? 10_000;
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeout);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { exitCode, stdout, stderr };
}

describe("CLI exit codes", () => {
  test("info on a fresh fifo: exit 0", async () => {
    const r = await runCli(["info", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.slug).toBe("cli-test");
    expect(parsed.counts).toEqual({ open: 0, lock: 0, done: 0, fail: 0 });
  });

  test("push 'hello' returns the new id and exits 0", async () => {
    const r = await runCli(["push", "hello"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i);
  });

  test("push via stdin pipes the body", async () => {
    const r = await runCli(["push"], { stdin: "via-stdin" });
    expect(r.exitCode).toBe(0);

    // peek confirms 2 open items now (from this and the prior push test).
    const peek = await fetch(`${base}/w/${fifoUlid}/peek`);
    const j = (await peek.json()) as { items: { data: string }[] };
    expect(j.items.map((i) => i.data)).toContain("via-stdin");
  });

  test("pop returns body and exits 0", async () => {
    const r = await runCli(["pop"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  test("pop on an empty queue: exit 1", async () => {
    // Drain remaining items first.
    while (true) {
      const r = await runCli(["pop"]);
      if (r.exitCode === 1) break;
      expect(r.exitCode).toBe(0);
    }
    const r = await runCli(["pop"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("status <unknown-id>: exit 1", async () => {
    const r = await runCli(["status", "01HXXXXXXXXXXXXXXXXXXXXXXX"]);
    expect(r.exitCode).toBe(1);
  });

  test("retry <unknown-id>: exit 1", async () => {
    const r = await runCli(["retry", "01HXXXXXXXXXXXXXXXXXXXXXXX"]);
    expect(r.exitCode).toBe(1);
  });

  test("list with bad status: exit 2 (usage error)", async () => {
    const r = await runCli(["list", "bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("status must be one of");
  });

  test("unknown command: exit 2", async () => {
    const r = await runCli(["doesnotexist"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  test("network error against bad URL: exit 2", async () => {
    const r = await runCli(["info", "-f", "http://127.0.0.1:1/nope"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("CLI .fifos-lock lifecycle", () => {
  test("pull writes .fifos-lock; ack deletes it", async () => {
    // Seed: push one item.
    const push = await runCli(["push", "ack-me"]);
    expect(push.exitCode).toBe(0);

    const lockPath = join(workDir, ".fifos-lock");
    expect(existsSync(lockPath)).toBe(false);

    const pull = await runCli(["pull"]);
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout.trim()).toBe("ack-me");
    expect(existsSync(lockPath)).toBe(true);
    const lockId = readFileSync(lockPath, "utf-8").trim();
    expect(lockId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i);

    const ack = await runCli(["ack"]);
    expect(ack.exitCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("nack deletes the lock file", async () => {
    await runCli(["push", "nack-me"]);
    const r = await runCli(["pull"]);
    expect(r.exitCode).toBe(0);

    const lockPath = join(workDir, ".fifos-lock");
    expect(existsSync(lockPath)).toBe(true);

    const nack = await runCli(["nack"]);
    expect(nack.exitCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("nack with positional reason persists fail_reason", async () => {
    const push = await runCli(["push", "boom-target"]);
    expect(push.exitCode).toBe(0);
    const itemId = push.stdout.trim();
    expect(await runCli(["pull"]).then((r) => r.exitCode)).toBe(0);

    const nack = await runCli(["nack", "ran", "out", "of", "memory"]);
    expect(nack.exitCode).toBe(0);

    const status = await fetch(`${base}/w/${fifoUlid}/status/${itemId}`);
    const j = (await status.json()) as {
      status: string;
      fail_reason: string | null;
    };
    expect(j.status).toBe("fail");
    expect(j.fail_reason).toBe("ran out of memory");
  });

  test("nack reads stdin when no positional reason is given", async () => {
    const push = await runCli(["push", "stdin-target"]);
    expect(push.exitCode).toBe(0);
    const itemId = push.stdout.trim();
    expect(await runCli(["pull"]).then((r) => r.exitCode)).toBe(0);

    const nack = await runCli(["nack"], { stdin: "stack trace from logs" });
    expect(nack.exitCode).toBe(0);

    const status = await fetch(`${base}/w/${fifoUlid}/status/${itemId}`);
    const j = (await status.json()) as { fail_reason: string | null };
    expect(j.fail_reason).toBe("stack trace from logs");
  });

  test("ack with no .fifos-lock: exit 2", async () => {
    const lockPath = join(workDir, ".fifos-lock");
    if (existsSync(lockPath)) unlinkSync(lockPath);
    const r = await runCli(["ack"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(".fifos-lock");
  });
});

describe("CLI pop --block --timeout", () => {
  test("--block --timeout 1 on empty queue: exit 1 within ~1.5s", async () => {
    const start = Date.now();
    const r = await runCli(["pop", "--block", "--timeout", "1"], {
      timeout: 5_000,
    });
    const elapsed = Date.now() - start;
    expect(r.exitCode).toBe(1);
    expect(elapsed).toBeLessThan(3_000);
    // And at least the timeout window — if it returned instantly that would
    // mean we're not actually blocking via SSE.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  test("--block returns the item when one is pushed mid-wait", async () => {
    const popPromise = runCli(["pop", "--block", "--timeout", "5"], {
      timeout: 8_000,
    });
    // Give the CLI a moment to subscribe to SSE before pushing.
    await new Promise((r) => setTimeout(r, 300));
    const push = await fetch(`${base}/w/${fifoUlid}/push`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "blocked-push",
    });
    expect(push.status).toBe(201);

    const r = await popPromise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("blocked-push");
  });
});
