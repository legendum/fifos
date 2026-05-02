/**
 * Type declarations for `legendum.js` (Legendum JS SDK).
 * Canonical copy: `legendum` repo `public/sdk/` — vendored into consuming apps as `src/lib/legendum.d.ts`.
 * Keep in sync with `legendum.js` (`module.exports` and behavior).
 */

/** Service client from `create()` / `service()`. */
export interface LegendumServiceClient {
  charge(
    accountToken: string,
    amount: number,
    description: string,
    opts?: { key?: string; meta?: unknown },
  ): Promise<{ email: string; transaction_id: number; balance: number }>;
  balance(accountToken: string): Promise<{ balance: number; held: number }>;
  reserve(
    accountToken: string,
    amount: number,
    description?: string,
  ): Promise<LegendumReservation>;
  requestLink(): Promise<{ code: string; request_id: string }>;
  pollLink(requestId: string): Promise<{
    status: string;
    account_token?: string;
  }>;
  authUrl(opts: { redirectUri: string; state: string }): string;
  authAndLinkUrl(opts: {
    redirectUri: string;
    state: string;
    linkCode: string;
  }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{
    email: string;
    linked: boolean;
    account_token?: string;
  }>;
  linkKey(
    accountKey: string,
  ): Promise<{ account_token: string; email: string }>;
  /**
   * Issue a Legendum Account Key for a user this service is already linked to.
   * @throws err.code forbidden | unauthorized | rate_limited | bad_request (see SDK header)
   */
  issueKey(
    accountToken: string,
    opts?: { label?: string },
  ): Promise<{
    key: string;
    key_prefix: string;
    label: string;
    id: number;
  }>;
  /** Batched micro-charges; uses this client for `charge` (same as top-level `tab` with `{ client }`). */
  tab(
    accountToken: string,
    description: string,
    opts: LegendumTabOptions,
  ): LegendumTab;
  waitForLink(
    requestId: string,
    opts?: { interval?: number; timeout?: number },
  ): Promise<{
    status: string;
    account_token?: string;
  }>;
}

/** Reservation returned by `reserve()`. */
export interface LegendumReservation {
  id: unknown;
  amount: number;
  settle: (
    settleAmount?: number,
  ) => Promise<{ email: string; transaction_id: number; balance: number }>;
  release: () => Promise<unknown>;
}

/** Account client from `account()` (`lak_*` key). */
export interface LegendumAccountClient {
  /** Verified account identity (email). */
  whoami(): Promise<{ email?: string } & Record<string, unknown>>;
  balance(): Promise<Record<string, unknown>>;
  transactions(limit?: number): Promise<unknown>;
  link(code: string): Promise<unknown>;
  unlink(domain: string): Promise<unknown>;
  authorize(opts: {
    clientId: string;
    redirectUri: string;
    state: string;
  }): Promise<{ code: string; redirect_uri: string; state: string }>;
}

/** Non-throwing wrapper from `client()`. */
export interface LegendumSafeClient {
  charge: (
    ...args: Parameters<LegendumServiceClient["charge"]>
  ) => Promise<
    | { ok: true; data: Awaited<ReturnType<LegendumServiceClient["charge"]>> }
    | { ok: false; error: string; code?: string }
  >;
  balance: (
    ...args: Parameters<LegendumServiceClient["balance"]>
  ) => Promise<
    | { ok: true; data: Awaited<ReturnType<LegendumServiceClient["balance"]>> }
    | { ok: false; error: string; code?: string }
  >;
  reserve: (
    ...args: Parameters<LegendumServiceClient["reserve"]>
  ) => Promise<
    | { ok: true; data: Awaited<ReturnType<LegendumServiceClient["reserve"]>> }
    | { ok: false; error: string; code?: string }
  >;
  requestLink: (
    ...args: Parameters<LegendumServiceClient["requestLink"]>
  ) => Promise<
    | {
        ok: true;
        data: Awaited<ReturnType<LegendumServiceClient["requestLink"]>>;
      }
    | { ok: false; error: string; code?: string }
  >;
  pollLink: (
    ...args: Parameters<LegendumServiceClient["pollLink"]>
  ) => Promise<
    | { ok: true; data: Awaited<ReturnType<LegendumServiceClient["pollLink"]>> }
    | { ok: false; error: string; code?: string }
  >;
  waitForLink: (
    ...args: Parameters<LegendumServiceClient["waitForLink"]>
  ) => Promise<
    | {
        ok: true;
        data: Awaited<ReturnType<LegendumServiceClient["waitForLink"]>>;
      }
    | { ok: false; error: string; code?: string }
  >;
  authUrl: LegendumServiceClient["authUrl"];
  authAndLinkUrl: LegendumServiceClient["authAndLinkUrl"];
  exchangeCode: (
    ...args: Parameters<LegendumServiceClient["exchangeCode"]>
  ) => Promise<
    | {
        ok: true;
        data: Awaited<ReturnType<LegendumServiceClient["exchangeCode"]>>;
      }
    | { ok: false; error: string; code?: string }
  >;
  linkKey: (...args: Parameters<LegendumServiceClient["linkKey"]>) => Promise<
    | {
        ok: true;
        data: Awaited<ReturnType<LegendumServiceClient["linkKey"]>>;
      }
    | { ok: false; error: string; code?: string }
  >;
  issueKey: (...args: Parameters<LegendumServiceClient["issueKey"]>) => Promise<
    | {
        ok: true;
        data: Awaited<ReturnType<LegendumServiceClient["issueKey"]>>;
      }
    | { ok: false; error: string; code?: string }
  >;
  /** Sync factory: returns `{ ok, data }` or `{ ok, error }` (same pattern as Ruby `SafeClient#tab`). */
  tab: (
    accountToken: string,
    description: string,
    opts: LegendumTabOptions,
  ) =>
    | { ok: true; data: LegendumTab }
    | { ok: false; error: string; code?: string };
}

export interface LegendumTabOptions {
  threshold: number;
  amount?: number;
  client?: LegendumServiceClient;
}

export interface LegendumTab {
  readonly total: number;
  add(amount?: number): Promise<void>;
  /** Flush remainder without closing; tab stays usable. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LinkControllerState {
  status: "loading" | "unlinked" | "linking" | "linked" | "error";
  balance: number | null;
  error: string | null;
}

export interface LinkControllerOptions {
  mountAt?: string;
  linkUrl?: string;
  confirmUrl?: string;
  statusUrl?: string;
  baseUrl?: string;
  authLinkUrl?: string | null;
  client?: LegendumServiceClient;
  redirectUri?: string;
  state?: string;
  onChange?: (state: LinkControllerState) => void;
}

export interface LinkController {
  getState: () => LinkControllerState;
  checkStatus: () => void;
  startLink: () => void;
  startAuthAndLink: (csrfState?: string | null) => void;
  accountUrl: string;
  destroy: () => void;
}

/** Aliases for older imports (e.g. `LegendumLinkState` from `legendum.d.js`). Prefer `LinkController*`. */
export type LegendumLinkState = LinkControllerState;
export type LegendumLinkController = LinkController;
export type LegendumLinkControllerOptions = LinkControllerOptions;
export type LegendumLinkRequest = Awaited<
  ReturnType<LegendumServiceClient["requestLink"]>
>;
export type LegendumAuthAndLinkUrlOptions = Parameters<
  LegendumServiceClient["authAndLinkUrl"]
>[0];

/**
 * Passed to `middleware()`. Callbacks use `apply` with trailing args from the host
 * (see `legendum.js` — e.g. user id; may be more in other apps).
 */
export interface MiddlewareOptions {
  prefix?: string;
  getToken: (request: Request, ...extra: unknown[]) => Promise<string | null>;
  setToken: (
    request: Request,
    accountToken: string,
    ...extra: unknown[]
  ) => Promise<void>;
  /** When Legendum returns token_not_found on status/balance, clear stored token (optional). */
  clearToken?: (request: Request, ...extra: unknown[]) => Promise<void>;
  /** After successful `POST …/confirm` + `setToken` (optional). */
  onLink?: (
    request: Request,
    accountToken: string,
    email: string | null,
    ...extra: unknown[]
  ) => Promise<void>;
  /** After successful `POST …/link-key` / `linkKey` (optional). Same `email` shape as `onLink`. */
  onLinkKey?: (
    request: Request,
    accountToken: string,
    email: string | null,
    ...extra: unknown[]
  ) => Promise<void>;
  /**
   * After successful `POST …/issue-key` (optional). Raw key once — encrypt and store.
   * Errors swallowed (best-effort).
   */
  onIssueKey?: (
    request: Request,
    key: string,
    keyPrefix: string,
    ...extra: unknown[]
  ) => Promise<void>;
  client?: LegendumServiceClient;
}

/** @deprecated Prefer `MiddlewareOptions` — kept for older codebases */
export type LegendumMiddlewareOptions = MiddlewareOptions;

export type LegendumMiddlewareHandler = (
  request: Request,
  ...extra: unknown[]
) => Promise<Response | null | undefined>;

/** @deprecated Prefer `LegendumMiddlewareHandler` */
export type LegendumMiddleware = LegendumMiddlewareHandler;

export interface ButtonOptions {
  url?: string;
  label?: string;
  target?: string;
}

export interface LinkWidgetOptions {
  mountAt?: string;
  linkUrl?: string;
  confirmUrl?: string;
  statusUrl?: string;
  baseUrl?: string;
}

/** Handlers for `mock()` — optional overrides; omitted methods use SDK defaults. */
export interface LegendumMockHandlers {
  charge?: LegendumServiceClient["charge"];
  balance?: LegendumServiceClient["balance"];
  reserve?: LegendumServiceClient["reserve"];
  requestLink?: LegendumServiceClient["requestLink"];
  pollLink?: LegendumServiceClient["pollLink"];
  waitForLink?: LegendumServiceClient["waitForLink"];
  authUrl?: LegendumServiceClient["authUrl"];
  authAndLinkUrl?: LegendumServiceClient["authAndLinkUrl"];
  exchangeCode?: LegendumServiceClient["exchangeCode"];
  linkKey?: LegendumServiceClient["linkKey"];
  issueKey?: LegendumServiceClient["issueKey"];
  tab?: LegendumServiceClient["tab"];
}

export interface LegendumCreateConfig {
  apiKey?: string;
  secret?: string;
  baseUrl?: string;
}

declare const legendum: {
  create: (config?: LegendumCreateConfig) => LegendumServiceClient;
  service: (config?: LegendumCreateConfig) => LegendumServiceClient;
  account: (
    accountKey: string,
    config?: { baseUrl?: string },
  ) => LegendumAccountClient;
  client: (existing?: LegendumServiceClient) => LegendumSafeClient;
  isConfigured: () => boolean;

  charge: (
    accountToken: string,
    amount: number,
    description: string,
    opts?: { key?: string; meta?: unknown },
  ) => ReturnType<LegendumServiceClient["charge"]>;
  balance: (
    accountToken: string,
  ) => ReturnType<LegendumServiceClient["balance"]>;
  reserve: (
    accountToken: string,
    amount: number,
    description?: string,
  ) => ReturnType<LegendumServiceClient["reserve"]>;
  requestLink: () => ReturnType<LegendumServiceClient["requestLink"]>;
  pollLink: (
    requestId: string,
  ) => ReturnType<LegendumServiceClient["pollLink"]>;
  waitForLink: (
    requestId: string,
    opts?: { interval?: number; timeout?: number },
  ) => ReturnType<LegendumServiceClient["waitForLink"]>;
  tab: (
    accountToken: string,
    description: string,
    opts: LegendumTabOptions,
  ) => LegendumTab;

  authUrl: (opts: { redirectUri: string; state: string }) => string;
  authAndLinkUrl: (opts: {
    redirectUri: string;
    state: string;
    linkCode: string;
  }) => string;
  exchangeCode: (
    code: string,
    redirectUri: string,
  ) => ReturnType<LegendumServiceClient["exchangeCode"]>;
  linkKey: (accountKey: string) => ReturnType<LegendumServiceClient["linkKey"]>;
  issueKey: (
    accountToken: string,
    opts?: { label?: string },
  ) => ReturnType<LegendumServiceClient["issueKey"]>;

  button: (opts?: ButtonOptions) => string;
  linkWidget: (opts: LinkWidgetOptions) => string;
  linkController: (opts: LinkControllerOptions) => LinkController;
  middleware: (opts: MiddlewareOptions) => LegendumMiddlewareHandler;

  mock: (handlers?: LegendumMockHandlers) => void;
  unmock: () => void;

  version: "1.0.0";
};

export default legendum;
