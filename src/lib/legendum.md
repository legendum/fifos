# Legendum SDK — Integration Guide

You are integrating Legendum (credit-based billing) into a service. This doc tells you exactly which pieces to use and how. The canonical implementations are `legendum.js` (Node/Bun/Deno/Workers) and `legendum.rb` (Ruby). Both ship next to this file.

**Audience:** a developer or coding agent dropping the SDK into a new project. Read §1, pick a flow in §3, copy the recipe.

---

## 1. Mental model (read this first)

Legendum is a credit-based billing service. Users top up a balance of **credits** at legendum.co.uk; services your users have linked can spend those credits on their behalf.

**The credit unit.** Credits are displayed as **Ⱡ** (U+2C60, e.g. `Ⱡ 100`) in the Legendum UI. Users buy them in bulk packs (£5–£80, with larger packs giving bonus credits). There is no fixed £/credit rate — bigger packs are cheaper per credit. Your service decides what one credit is worth in *your* domain ("1 credit = 1 API call", "1 credit = 1000 LLM tokens", "1 credit = 1 MB·hour of storage", etc.). Users top up manually or via auto top-up.

**Credits are integers at the wire.** `/api/charge`, `/api/reserve`, and `/api/settle` all enforce `Number.isInteger(amount) && amount > 0`. The user-facing balance, transaction amounts, and pack sizes are all integers. To bill in fractional units (e.g. 0.01 credits per LLM token), use `tab()` — it accepts fractional `add()` amounts, accumulates them client-side, and floors to whole credits when flushing. The fractional remainder carries over to the next flush; any sub-credit dust at `close()` is dropped (never rounded up — we never overcharge).

**Multiple services share one Legendum account.** A user can link the same Legendum account to as many services as they like; each service gets its own scoped, opaque `account_token`. They see all services and per-service weekly spend on their `/account` page.

Legendum gives your service three things:

- **Service credentials** — `LEGENDUM_API_KEY` (`lpk_…`) and `LEGENDUM_SECRET` (`lsk_…`). Server-only. Never expose to the browser.
- **A per-user account token** — opaque string returned when a user links their Legendum account to your service. Persist it on the user row. This is what you pass to `charge` / `balance` / `reserve` / `tab`. **Important:** this token changes on every re-link (e.g. logging in from a new device triggers a new link flow, which generates a fresh token). Do **not** use it as a user identity key — use the `email` returned by `exchangeCode` / `linkKey` instead. Update the stored token on every login so billing calls use the current one.
- **A user-held account key** (`lak_…`) — held by the *user*, not your service. Used by paste-a-key flows (CLIs, agents) and by `account()` clients that act on behalf of one human.

Three jobs you'll do:

1. **Link** a user's Legendum account to your service (one of four flows — §3).
2. **Bill** them for work (one of four primitives — §4).
3. **Handle errors** (one short table — §5).

---

## 2. Setup

```
src/lib/legendum.js   ← copy from legendum repo public/sdk/ (canonical; keep in sync)
src/lib/legendum.md   ← same source — integration guide, ships next to the SDK
src/lib/legendum.d.ts ← same public/sdk/ — TypeScript declarations for the SDK
.env:
  LEGENDUM_API_KEY=lpk_...
  LEGENDUM_SECRET=lsk_...
  LEGENDUM_BASE_URL=https://legendum.co.uk    # override for staging/local
```

```js
import legendum from "./lib/legendum.js";
if (!legendum.isConfigured()) console.warn("Legendum disabled");
```

- The top-level `legendum.charge(...)` etc. lazily build a default client from env. Use that. Only call `legendum.create({ apiKey, secret })` for non-default clients (multi-tenant, tests).
- **TypeScript:** copy `legendum.d.ts` from `public/sdk/` next to `legendum.js` (canonical; keep in sync with the JS file).
- **Tests:** `legendum.mock({ charge: () => ({...}) })` at start, `legendum.unmock()` in teardown. `isConfigured()` returns true while mocked.
- **Local dev:** point `LEGENDUM_BASE_URL` at a local instance. All primitives + middleware respect it.

---

## 3. Linking flows — pick ONE

| Use-case | Flow | §  |
|---|---|---|
| Web app, you want Legendum to be the identity provider | **Login with Legendum** (OAuth) | 3.1 |
| Web app with existing accounts, adding billing | **linkController + middleware** (popup) | 3.2 |
| CLI / agent / headless tool | **`linkKey(accountKey)`** | 3.3 |
| Tooling that acts *as* a user | **`account(lak_…)`** | 3.4 |
| Trusted service auto-issuing keys for downstream services | **`issueKey(accountToken)`** | 3.5 |

You can mix flows in one service (e.g. OAuth for the web app, `linkKey` for the CLI).

### 3.1 Login with Legendum (OAuth) — recommended for new web apps

```ts
// Step 1: redirect to Legendum
const url = legendum.authUrl({ redirectUri, state: csrfToken });
return Response.redirect(url);

// Step 2: in your callback at redirectUri
const data = await legendum.exchangeCode(code, redirectUri);
// { email, linked, account_token? }
if (data.linked && data.account_token) {
  await db.users.update(user.id, { account_token: data.account_token });
}
```

**Login + link in one step** (recommended): call `requestLink()` first, then `authAndLinkUrl({ redirectUri, state, linkCode })`. The user authorizes *and* pairs in one redirect.

```ts
const { code: linkCode } = await legendum.requestLink();
const url = legendum.authAndLinkUrl({ redirectUri, state, linkCode });
return Response.redirect(url);
// In callback: exchangeCode returns linked: true with account_token immediately when paired.
```

Notes:
- `state` = your CSRF token. Generate per-request, store in a short-lived cookie, verify on callback.
- `redirectUri` must be **registered** with Legendum, exact match between authorize and `exchangeCode`.
- `linked: false` means they authenticated but didn't link a billing account — decide whether to prompt or allow free-tier.

### 3.2 linkController + middleware — recommended for existing-account web apps

Best when users already have accounts and you're bolting billing on. User clicks → popup → page polls → linked.

**Server:**
```ts
const handler = legendum.middleware({
  prefix: "/legendum",
  getToken:   async (req, user) => user.account_token,
  setToken:   async (req, accountToken, user) =>
    db.users.update(user.id, { account_token: accountToken }),
  clearToken: async (req, user) => db.users.update(user.id, { account_token: null }),
  onLink:     async (req, token, email, user) => {           // optional
    // `email` is the verified Legendum account email
    await sendWelcomeEmail(email);
    await audit.log("legendum_linked", { user_id: user.id, email });
  },
});

// In your router (extra args after `request` are forwarded to callbacks):
const res = await handler(request, currentUser);
if (res) return res;
```

This exposes `POST {prefix}/link`, `POST {prefix}/auth-link`, `POST {prefix}/link-key`, `POST {prefix}/issue-key`, `POST {prefix}/confirm`, `GET {prefix}/status`.

**Browser:**
```js
const ctrl = legendum.linkController({
  mountAt: "/legendum",
  onChange: (state) => render(state),    // { status, balance, error }
});
ctrl.checkStatus();
// On click: ctrl.startLink()    // popup + poll
// On unmount: ctrl.destroy()
```

For static pages without a framework, use `linkWidget({ mountAt: "/legendum" })` instead — returns drop-in HTML+JS.

For login+link in this flow, set `redirectUri` and `state` on the controller and call `ctrl.startAuthAndLink()` (full-page nav, no popup).

Notes:
- **Implement `clearToken`.** Without it, dead tokens stick around forever — `/status` calls `clearToken` when Legendum returns `token_not_found`.
- **`onLink` is optional** and fires once, right after `setToken` succeeds in `/confirm`. Signature: `(req, accountToken, email, ...extra)`. The `email` is the verified Legendum account email — same one you'd get from `exchangeCode` in the OAuth flow — and may be `null` in defensive edge cases. Use `onLink` for "user just linked" side effects (welcome email, audit log, session refresh, analytics). Errors thrown inside `onLink` are swallowed — a failing side effect must not break the link flow. Don't put load-bearing logic here.
- `startLink` must be called from a real user gesture or popup blockers eat it.
- Polling stops after 10 minutes; user can retry.

### 3.3 `linkKey(accountKey)` — agents, CLIs, scripts

User generates a `lak_…` on legendum.co.uk and pastes it once.

```ts
const { account_token, email } = await legendum.linkKey(accountKey);
// Persist `account_token` against the user/agent (your DB column may use another name). Discard the lak_.
```

Notes:
- Copy says "Legendum **account key**", not "API key" — avoids confusion with your own keys.
- Account keys are password-equivalent: never log, never echo back.
- The returned `account_token` is scoped to *your* `LEGENDUM_API_KEY`. Different services need separate links.

### 3.4 `account(lak_…)` — acting *as* a user

```ts
const acct = legendum.account(userKey);
await acct.whoami();
await acct.balance();
await acct.transactions(20);
await acct.link(pairingCode);
```

Use this for CLIs/scripts that manage one human's account. **Not** for billing your own service.

### 3.5 `issueKey(accountToken, { label? })` — auto-issue a `lak_…` for a linked user

Use when **your** service is already linked to a user (you have an `accountToken` from §3.1–§3.3) and you want to act *as* that user against **another** Legendum-powered service — without asking the user to paste a `lak_…` into your settings page.

```ts
const { key, key_prefix, id } = await legendum.issueKey(accountToken, {
  label: "MyApp — linked services",
});
// `key` is shown ONCE. Store encrypted, then pass it as Bearer to downstream services
// or feed it into their `linkKey(key)` flow (§3.3).
```

Returns: `{ key, key_prefix, label, id }`. The auto-issued key shows up on the user's `/account` page with the label you provided (default = your service domain), and the user can revoke it like any human-issued key.

Requires `can_issue_keys: true` for your service in Legendum's `config/services.yml` — Legendum operators flip this on per service. Without it, the call returns `forbidden` (403). Per `(service, account)` cap of ~10 keys/hour to catch re-issue loops.

**Browser-side:** the middleware (§3.2) exposes `POST {prefix}/issue-key` so your front-end can ask for a fresh key without ever seeing your service secret. Pair it with `onIssueKey: (req, key, keyPrefix, ...extra) => …` on the middleware to encrypt-and-store the raw key the moment it's issued (errors swallowed, best-effort — same contract as `onLink`/`onLinkKey`).

Errors: `forbidden` (flag off), `unauthorized` (bad creds, or the `accountToken` is unknown / inactive / belongs to a different service), `rate_limited`, `bad_request`.

The Ruby SDK mirrors this as `Client#issue_key(account_token, label:)` and `Middleware`'s `POST {prefix}/issue-key` route + `on_issue_key:` callback.

---

## 4. Billing primitives — pick ONE per work-stream

All take an `accountToken` (the link token from §3, stored on the user row).

**Descriptions are user-visible.** The `description` you pass to `charge` / `reserve` / `tab` shows up in the user's transaction history on legendum.co.uk/account. Write them as short, human-readable labels ("AI turn", "API call", "piped.sh commands") — not internal request ids or debug strings.

### 4.1 `charge(token, amount, description, opts?)` — fixed cost, atomic
Use when cost is known up-front and discrete.
```ts
await legendum.charge(token, 10, "API call", { key: requestId });
```
Pass `opts.key` (your request id) for idempotency — Legendum dedupes per service. Pass `opts.meta` (object) to attach arbitrary JSON to the transaction record (debugging, audit trail).

### 4.2 `reserve(token, max, description?)` → `{ id, settle, release }` — variable cost
**The dominant pattern.** Use when the cost is unknown until the work runs (LLM calls, jobs with variable output).
```ts
const r = await legendum.reserve(token, maxCost, "AI turn");
try {
  const result = await runWork();
  await r.settle(actualCost);   // ≤ reserved
} catch (err) {
  await r.release();
  throw err;
}
```
**Critical:**
- Always try/finally — leaked reservations lock credits for 15 minutes.
- `settle` accepts an amount **lower** than reserved, never higher. If actual > reserved: `settle(reserved)` and `charge` the overflow.
- Second `settle`/`release` throws `invalid_state` — treat as benign in cleanup.
- `expired` (410) = 15 min passed. Don't bill, log, decide whether to retry. Don't error the user request.

### 4.3 `tab(token, description, { threshold, amount? })` — micro-charges
Use when units are too small to charge individually (per LLM token, per stored byte).
```ts
const t = legendum.tab(token, "piped.sh commands", { threshold: 100 });
await t.add();      // +1
await t.add(5);
// ...
await t.close();    // MANDATORY — flushes the remainder
```
**Critical:**
- `close()` is mandatory at process shutdown only (SIGTERM/SIGINT) — **never** in a request `finally`. See the long-lived rule below. SIGKILL loses unflushed credits — accepted.
- `add()` accepts fractional amounts (e.g. `t.add(0.003)`); they accumulate internally and are floored when flushing. Non-numeric or non-positive values throw.
- `flush()` settles the running total without closing the tab — use it from a periodic timer to drain partial balances that linger below `threshold` (e.g. slow-accumulating storage credits).
- `await` `add()` so backpressure works (it may flush).
- **Tabs MUST be long-lived.** One tab per `(token, description)`, stored in a module-level `Map` keyed by token, kept for the lifetime of the process. **Never create a tab per request / per job / per session** — `close()` floors the total and drops any sub-1 remainder, so a short-lived tab forfeits dust on every close. With fractional `add()` (e.g. 0.01/token) a per-request tab would lose almost everything. Long-lived tabs roll the remainder into the next whole credit and lose at most <1 credit per tab on process exit. Multiple billable streams → multiple tabs, but each one still long-lived.
- Don't reuse after `close()`.

### 4.4 `balance(token)` → `{ balance, held }` — read-only
For UI display, low-balance warnings, status routes. **Do not** poll in a hot path. `held` = sum of active reservations.

---

## 5. Error handling

Every async method throws. `err.code`, `err.message`, `err.status`.

**Wire format.** Legendum JSON errors look like `{ "ok": false, "error": "insufficient_funds", "message": "Account balance is …" }`: **`message`** is human-readable, **`error`** is the machine code. The SDKs map those onto thrown errors (`message` → `err.message`, `error` → `err.code`). If a response omits `error`, `err.code` may be missing — use `err.status` and `err.message` as fallbacks. The **`middleware`** routes under `{prefix}/…` return the same shape on failure (both fields when a code is known).

| Code | Meaning | Action |
|---|---|---|
| `insufficient_funds` (402) | Balance too low | Stop work, show "top up" link (`legendum.button({ url })` or `https://legendum.co.uk/account`) |
| `token_not_found` (404) | Stored token revoked / dead | Clear it, prompt re-link |
| `invalid_state` (409) | Settle/release on non-held reservation | Benign in cleanup; investigate in hot path |
| `expired` (410) | Reservation > 15 min | Don't bill; log; decide retry |
| `link_expired` (410) | Pairing code expired | Restart link flow |
| `unauthorized` (401) | Bad service credentials | Fail loud at startup |
| `http_<status>` (e.g. `http_502`) | Non-JSON upstream | Transient — retry with backoff |

**Patterns:**
- **Degrade gracefully.** Wrap charge/reserve so a Legendum 5xx doesn't take down your service. Per use-case decide: fail open (let the work run, log) or fail closed (refuse, return 503). Cheap reads → fail open. Expensive LLM turns → fail closed.
- **Non-throwing wrapper.** `legendum.client(c)` wraps any client so methods return `{ ok, data?, error?, code? }` instead of throwing. On failure, **`error`** is the human-readable string (same text as a thrown `err.message`); **`code`** is the machine code when present (same as `err.code`). That naming differs from raw HTTP JSON, which uses **`message`** for humans — only the safe client uses the key `error` for that string.

---

## 6. Recipe: integrating into a new service in 8 steps

1. **Copy** `legendum.js`, `legendum.md`, and (for TypeScript) `legendum.d.ts` from `public/sdk/` → e.g. `src/lib/`.
2. **Register** the service with Legendum: get `lpk_…`/`lsk_…`, register `redirectUri` if using OAuth.
3. **Add env vars** + an `isConfigured()` check at startup. Gate billing on it so dev environments work without credentials.
4. **Pick a linking flow** (§3). Persist the token on the user row. Implement `clearToken`.
5. **Pick a billing primitive** (§4). `reserve` for variable cost; `tab` for micro-units; `charge` for fixed cost.
6. **Wire `clearToken` + graceful degradation** (§5) before going live.
7. **Mock in tests** so CI doesn't need real credentials.
8. **Add a "Buy credits" affordance.** `legendum.button({ url })` or a link to `https://legendum.co.uk/account`. Surface low-balance warnings via `balance()`.

---

## 7. Edge cases & gotchas

- **Browser security:** never put `LEGENDUM_SECRET` in the page. If `linkController` is configured with `opts.client`, that client must run server-side. Prefer `mountAt` + middleware so the secret stays on the server.
- **Tokens can be revoked remotely.** A user revoking their Legendum account key (`lak_…`) on legendum.co.uk deactivates *every* service link that was created via that key (i.e. via `linkKey` — §3.3). OAuth and popup-pairing links survive. The symptom is a previously-working `account_token` suddenly returning `token_not_found` (404) on `charge`/`balance`. This is **not** a bug — it's the user severing the credential. Recovery is automatic if you've implemented `clearToken` (§3.2/§5): the middleware `/status` route catches the 404, fires `clearToken`, and your UI prompts the user to re-link. If you're not using middleware, handle `token_not_found` yourself wherever you call `charge`/`balance`.
- **Tokens change on re-link.** Each link flow (OAuth, popup, paste-a-key) generates a fresh `account_token`, overwriting the previous one in Legendum's `account_services` table. The old token is dead — billing calls with it will fail. Always update your stored token on login/re-link. Never use the token as a user identity key; use `email` instead.
- **Email changes at Legendum.** Changing verified email on legendum.co.uk does **not** invalidate an existing service link or `account_token`. It *can* leave your database out of date if you keyed display or support on an email captured once at signup. Successful **`charge`** and **`settle`** payloads include **`email`** — the verified address Legendum used for that debit. Services that care about an up-to-date identity should treat that field as authoritative when present (e.g. update the user row when it differs). The next **`exchangeCode`** after login also returns the current email; billing responses help you stay in sync between logins.
- **Token race:** two concurrent links for the same user produce two tokens; second `setToken` wins. Either lock per-user or accept the orphan (it still works).
- **Reservations across restarts:** don't try to recover them. Held credits expire on Legendum's side after 15 min. Just let them expire.
- **Tab lifetime:** tabs must live for the *process*, not the request. Store them in a module-level `Map<token, tab>` and reuse across calls. A per-request tab drops its sub-1 remainder on every `close()` and bleeds dust continuously — see §4.3. Wire `close()` only to process-shutdown hooks (SIGTERM/SIGINT), never to request-end.
- **Polling intervals:** the default 3s in `linkController` is rate-limited. Don't lower it.
- **CSRF state:** opaque to Legendum. Use a signed cookie or server nonce, not a cleartext user id.
- **Multiple streams:** one tab per stream, one reservation per work-unit. Don't mix.
- **`exchangeCode` redirect_uri:** must exactly match the one used in `authUrl` / `authAndLinkUrl`.
- **Idempotency keys** (`opts.key` on `charge`): use your own request id, not random — the point is dedup on retries.

---

## 8. Quick reference — top-level API

```
Setup
  legendum.create({ apiKey, secret, baseUrl })       → service client
  legendum.account(lak_, { baseUrl })                → user-key client
  legendum.client(c)                                  → non-throwing wrapper
  legendum.isConfigured()                             → bool
  legendum.mock(handlers) / legendum.unmock()         → tests

Billing (all take an accountToken)
  legendum.charge(token, amount, desc, { key, meta }?)
  legendum.reserve(token, amount, desc?)              → { id, settle, release }
  legendum.tab(token, desc, { threshold, amount? })   → { add, flush, close, total }
  legendum.balance(token)                             → { balance, held }

Linking — OAuth
  legendum.authUrl({ redirectUri, state })            → URL string
  legendum.authAndLinkUrl({ redirectUri, state, linkCode })
  legendum.exchangeCode(code, redirectUri)            → { email, linked, account_token? }

Linking — pairing-code
  legendum.requestLink()                              → { code, request_id }
  legendum.pollLink(request_id)                       → { status, account_token? }
  legendum.waitForLink(request_id, { interval, timeout }?)

Linking — paste-a-key
  legendum.linkKey(lak_)                          → { account_token, email }

Linking — auto-issue (trusted service, §3.5)
  legendum.issueKey(accountToken, { label? })         → { key, key_prefix, label, id }

UI helpers
  legendum.button({ url, label, target })             → HTML
  legendum.linkWidget({ mountAt | linkUrl/confirmUrl/statusUrl })  → HTML+JS
  legendum.linkController({ mountAt, onChange, ... }) → { startLink, startAuthAndLink, checkStatus, destroy }
  legendum.middleware({ prefix, getToken, setToken, clearToken, onLink?, onLinkKey?, onIssueKey? })  → handler(req, ...extra)
```

The Ruby SDK (`legendum.rb`) mirrors the same API. Method names match where idiomatic.

---

## 9. Where does the account token come from?

The **account token** (the opaque string you pass to `charge`, `balance`, `reserve`, and `tab`) is **created when your service is linked** to the user’s Legendum account. It is **not** the user’s account key (`lak_…`). On the wire, Legendum always names this value **`account_token`** in JSON (OAuth, pairing, and `linkKey` responses). Your database column can use a different name (e.g. `legendum_token`) if you prefer — map at the boundary when you persist.

### HTTP / JSON (`account_token` on the wire)

If you call Legendum’s **REST API** directly (or read raw requests/responses), use this field name consistently:

| Surface | Name |
|---------|------|
| OAuth exchange JSON (`POST /api/auth/token`) | **`account_token`** |
| Agent link-key JSON (`POST /api/agent/link-key`) | **`account_token`** |
| Pairing poll (`GET /api/link/:requestId`) | **`account_token`** |
| Balance query (`GET /api/balance`) | **`account_token`** (query parameter) |
| Charge / reserve / settle / release request bodies | **`account_token`** |

### Methods that **give you** an account token (to store)

| Flow | Method | When you get a token |
|------|--------|----------------------|
| **OAuth** (Login with Legendum or login-and-link) | `exchangeCode(code, redirectUri)` | When `linked` is true — field is **`account_token`**. |
| **Pairing** (popup / `linkController` + middleware) | `pollLink(requestId)` or `waitForLink(requestId)` | When `status === "confirmed"` — field is **`account_token`**. Middleware `POST …/confirm` surfaces the same. |
| **Paste-a-key** (CLI, agents) | `linkKey(accountKey)` | Always on success — field is **`account_token`** (plus `email`). |

### Methods that **do not** return an account token

- **`authUrl`** / **`authAndLinkUrl`** — return only a **URL string**. The token appears **after** the user returns to your app and you call **`exchangeCode`** (or after pairing completes and you **`pollLink`**).
- **`requestLink`** — returns a **pairing `code`** and `request_id`, not the billing token. The account token arrives once the user confirms at Legendum and **`pollLink`** reports `confirmed`.
- **`charge`**, **`balance`**, **`reserve`**, **`tab`** — **consume** an account token you already have; they do not issue a new link. (Responses may include `email` for the transaction — that is not the token.)

### `account(lak_…)` vs the account token

- **`account(accountKey)`** builds a client that uses the user’s **Legendum account key** (`lak_…`) for **agent** endpoints (`whoami`, agent `balance`, `link`, etc.) — see §3.4.
- That **`lak_…` is not** the per-service **`account_token`** stored for **your** service’s billing. For billing your product, use the token from **`exchangeCode`**, **`linkKey`**, or confirmed **`pollLink`**.

For architectural choices (OAuth vs pairing vs paste-a-key), see [patterns.md](patterns.md).
