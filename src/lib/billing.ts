import { getDb } from "./db.js";
import { isSelfHosted } from "./mode.js";

// @ts-expect-error — pure JS SDK
const legendum = require("./legendum.js");

export function isConfigured(): boolean {
  return legendum.isConfigured();
}

/** Module-level tabs map: one long-lived tab per user token. */
const tabs = new Map<string, any>();

function getTab(token: string): any {
  if (!tabs.has(token)) {
    const t = legendum.tab(token, "fifos.in writes", { threshold: 2 });
    tabs.set(token, t);
  }
  return tabs.get(token);
}

function getUserToken(userId: number): string | null {
  const db = getDb();
  const row = db
    .query("SELECT legendum_token FROM users WHERE id = ?")
    .get(userId) as { legendum_token: string | null } | undefined;
  return row?.legendum_token ?? null;
}

/** Charge for fifo creation (2 credits). Returns null on success, or an error Response. */
export async function chargeFifoCreate(
  userId: number,
): Promise<Response | null> {
  if (isSelfHosted()) return null;

  const token = getUserToken(userId);
  if (!token) {
    return new Response(
      JSON.stringify({
        error: "payment_required",
        message: "Link a Legendum account to create fifos",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    await legendum.charge(token, 2, "fifos.in fifo");
    return null;
  } catch (err: any) {
    if (err.code === "insufficient_funds") {
      return new Response(
        JSON.stringify({
          error: "insufficient_funds",
          message: "Not enough Legendum credits",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    if (err.code === "token_not_found") {
      const db = getDb();
      db.run("UPDATE users SET legendum_token = NULL WHERE id = ?", userId);
      return new Response(
        JSON.stringify({
          error: "payment_required",
          message: "Legendum account disconnected. Please re-link.",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    console.error("Legendum charge failed", err);
    return new Response(
      JSON.stringify({ error: "charge_failed", message: "Billing failed" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** Charge for a webhook write (0.01 credits via tab). Returns null on success, or an error Response. */
export async function chargeWebhookWrite(
  userId: number,
): Promise<Response | null> {
  if (isSelfHosted()) return null;

  const token = getUserToken(userId);
  if (!token) {
    return new Response(
      JSON.stringify({
        error: "payment_required",
        message: "Link a Legendum account",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const tab = getTab(token);
    await tab.add(0.01);
    return null;
  } catch (err: any) {
    if (err.code === "insufficient_funds") {
      return new Response(
        JSON.stringify({
          error: "insufficient_funds",
          message: "Not enough Legendum credits",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    if (err.code === "token_not_found") {
      const db = getDb();
      db.run("UPDATE users SET legendum_token = NULL WHERE id = ?", userId);
      tabs.delete(token);
      return new Response(
        JSON.stringify({
          error: "payment_required",
          message: "Legendum account disconnected",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    console.error("Legendum tab add failed", err);
    return new Response(
      JSON.stringify({ error: "charge_failed", message: "Billing failed" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** Graceful shutdown: close all open tabs. */
export async function closeTabs(): Promise<void> {
  for (const [_token, tab] of tabs) {
    try {
      await tab.close();
    } catch {}
  }
  tabs.clear();
}
