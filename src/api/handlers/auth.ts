import {
  clearAuthCookieHeader,
  getDomain,
  setAuthCookieHeader,
} from "../../lib/auth.js";
import { getDb } from "../../lib/db.js";
import { seedDefaultFifosForNewUser } from "../../lib/seed-default-fifos.js";
import { json } from "../json.js";

// @ts-expect-error — pure JS SDK
const legendum = require("../../lib/legendum.js");

type LegendumExchange = {
  email: string;
  linked: boolean;
  account_token?: string;
};

export async function getLogin(_req: Request): Promise<Response> {
  const domain = getDomain();
  const state = crypto.randomUUID();
  const redirectUri = `${domain}/auth/callback`;

  const linkData = await legendum.requestLink();
  const url = legendum.authAndLinkUrl({
    redirectUri,
    state,
    linkCode: linkData.code,
  });

  const stateCookie = `fifos_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": stateCookie,
    },
  });
}

export async function getCallback(req: Request): Promise<Response> {
  const domain = getDomain();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return json(
      { error: "invalid_request", message: "Missing code or state" },
      400,
    );
  }

  const cookie = req.headers.get("Cookie") ?? "";
  const stateMatch = cookie.match(/fifos_oauth_state=([^;]+)/);
  const savedState = stateMatch?.[1];
  if (state !== savedState) {
    return json({ error: "invalid_state", message: "State mismatch" }, 400);
  }

  const redirectUri = `${domain}/auth/callback`;

  let data: LegendumExchange;
  try {
    data = (await legendum.exchangeCode(code, redirectUri)) as LegendumExchange;
  } catch (err: unknown) {
    console.error("Legendum code exchange failed", err);
    return json({ error: "auth_failed", message: "Login failed" }, 400);
  }

  const db = getDb();
  const { email } = data;

  if (!email) {
    return json(
      { error: "auth_failed", message: "Could not read email from Legendum" },
      400,
    );
  }

  const serviceToken = data.account_token;

  let user = db.query("SELECT id FROM users WHERE email = ?").get(email) as {
    id: number;
  } | null;

  if (!user) {
    db.run(
      "INSERT INTO users (email, legendum_token) VALUES (?, ?)",
      email,
      serviceToken ?? null,
    );
    user = db.query("SELECT id FROM users WHERE email = ?").get(email) as {
      id: number;
    };
    seedDefaultFifosForNewUser(user.id);
  } else if (serviceToken) {
    db.run(
      "UPDATE users SET legendum_token = ? WHERE id = ?",
      serviceToken,
      user.id,
    );
  }

  const sessionCookie = setAuthCookieHeader(user.id);
  const clearState =
    "fifos_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", `${domain}/`],
      ["Set-Cookie", sessionCookie],
      ["Set-Cookie", clearState],
    ] as [string, string][],
  });
}

export async function postLogout(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookieHeader(),
    },
  });
}
