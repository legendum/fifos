import { describe, expect, test } from "bun:test";
import { clampSeconds, parseDuration } from "../src/lib/duration";

describe("parseDuration", () => {
  test("bare integer is seconds", () => {
    expect(parseDuration("600")).toBe(600);
    expect(parseDuration("1")).toBe(1);
  });

  test("'s' suffix is seconds", () => {
    expect(parseDuration("300s")).toBe(300);
    expect(parseDuration("10s")).toBe(10);
  });

  test("'m' suffix is minutes", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("60m")).toBe(3600);
  });

  test("'h' suffix is hours", () => {
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("2h")).toBe(7200);
  });

  test("case-insensitive and trims whitespace", () => {
    expect(parseDuration("  5M  ")).toBe(300);
    expect(parseDuration("1H")).toBe(3600);
    expect(parseDuration(" 600 ")).toBe(600);
  });

  test("rejects empty / nullish / whitespace-only", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  test("rejects non-positive integers", () => {
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("-5")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });

  test("rejects unrecognized suffix", () => {
    expect(parseDuration("5d")).toBeNull();
    expect(parseDuration("5ms")).toBeNull();
    expect(parseDuration("5sec")).toBeNull();
    expect(parseDuration("5 m")).toBeNull();
  });

  test("rejects non-numeric", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("m")).toBeNull();
    expect(parseDuration("five")).toBeNull();
    expect(parseDuration("1.5m")).toBeNull();
  });

  test("rejects mixed forms", () => {
    expect(parseDuration("1h30m")).toBeNull();
    expect(parseDuration("90s10")).toBeNull();
  });
});

describe("clampSeconds", () => {
  test("returns value within range", () => {
    expect(clampSeconds(300, 10, 3600)).toBe(300);
    expect(clampSeconds(10, 10, 3600)).toBe(10);
    expect(clampSeconds(3600, 10, 3600)).toBe(3600);
  });

  test("clamps below min to min", () => {
    expect(clampSeconds(5, 10, 3600)).toBe(10);
    expect(clampSeconds(0, 10, 3600)).toBe(10);
    expect(clampSeconds(-100, 10, 3600)).toBe(10);
  });

  test("clamps above max to max", () => {
    expect(clampSeconds(7200, 10, 3600)).toBe(3600);
    expect(clampSeconds(99999, 10, 3600)).toBe(3600);
  });
});

describe("parseDuration + clampSeconds (lock TTL pipeline)", () => {
  // This is exactly the pipeline used by queue.pull's `?lock=<dur>` param.
  const resolve = (raw: string | undefined, fallbackSeconds: number) => {
    const parsed = parseDuration(raw ?? "");
    return clampSeconds(parsed ?? fallbackSeconds, 10, 3600);
  };

  test("typical lock values", () => {
    expect(resolve("5m", 300)).toBe(300);
    expect(resolve("10m", 300)).toBe(600);
    expect(resolve("1h", 300)).toBe(3600);
    expect(resolve("600", 300)).toBe(600);
  });

  test("missing override falls back to default", () => {
    expect(resolve(undefined, 300)).toBe(300);
    expect(resolve("", 300)).toBe(300);
  });

  test("unparseable falls back to default", () => {
    expect(resolve("forever", 300)).toBe(300);
    expect(resolve("5d", 300)).toBe(300);
  });

  test("out-of-range silently clamps", () => {
    expect(resolve("1s", 300)).toBe(10);   // below min
    expect(resolve("2h", 300)).toBe(3600); // above max
    expect(resolve("99999", 300)).toBe(3600);
  });
});
