/**
 * Legendum SDK for JavaScript/TypeScript
 * Zero dependencies — uses global fetch.
 *
 * Usage:
 *   const legendum = require('legendum-sdk')
 *   // or: import legendum from './legendum.js'
 *
 * Configuration (environment variables):
 *   LEGENDUM_API_KEY  — service API key (lpk_...)
 *   LEGENDUM_SECRET   — service secret  (lsk_...)
 *   LEGENDUM_BASE_URL — base URL (default: https://legendum.co.uk)
 *
 * Or pass config to create():
 *   const client = legendum.create({ apiKey, secret, baseUrl })
 *
 * Error handling:
 *   All methods throw on failure. The error object has:
 *     err.message — human-readable description (e.g. "Account balance is 50 but charge requires 100")
 *     err.code    — machine-readable code (e.g. "insufficient_funds")
 *     err.status  — HTTP status code (e.g. 402)
 *
 *   JSON error bodies from the Legendum API use { ok: false, error, message } — `message` for
 *   humans, `error` for the code. The SDK maps them onto Error.message / err.code. If a response
 *   omits `error`, err.code may be undefined (treat err.status and err.message as fallbacks).
 *
 *   Error codes:
 *     "unauthorized"        (401) — missing or invalid API key / secret
 *     "bad_request"         (400) — missing required fields or invalid values
 *     "token_not_found"     (404) — account token not found or inactive
 *     "insufficient_funds"  (402) — balance too low for the charge or reservation
 *     "invalid_state"       (409) — reservation is not in 'held' state
 *     "expired"             (410) — reservation has expired
 *     "link_expired"        (410) — pairing code has expired
 *     "not_found"           (404) — pairing code not found
 *     "invalid_code"        (400) — wrong email confirmation code
 *     "forbidden"           (403) — operation not allowed (e.g. issueKey when service lacks can_issue_keys)
 *     "rate_limited"        (429) — too many requests (e.g. issueKey hourly cap)
 *     "no_link"             (409) — middleware POST …/issue-key when no account_token is stored
 *     "http_<status>"       (5xx) — non-JSON response (server crash, proxy
 *                                    error page, misconfigured base URL)
 *
 *   Example:
 *     try {
 *       await client.charge(token, 100, "API call");
 *     } catch (err) {
 *       if (err.code === "insufficient_funds") {
 *         // prompt user to buy more credits
 *       }
 *     }
 *
 * Testing:
 *   legendum.mock({
 *     charge: (token, amount, desc) => ({ email: "mock@test.com", transaction_id: 1, balance: 50 }),
 *   });
 *   // isConfigured() returns true, all methods use mock handlers
 *   legendum.unmock();
 */

function readEnv(name) {
  if (typeof process !== "undefined" && process.env) return process.env[name];
  return undefined;
}

// Internal: builds a transport pair { base, request } given a base URL and a
// header-builder. Both create() (service client) and account() (account client)
// share request shape: JSON body, JSON response, throw on { ok: false } with
// err.message from body.message (else body.error), err.code from body.error, err.status from HTTP.
function makeTransport(baseUrl, buildHeaders) {
  var base = baseUrl.replace(/\/+$/, "");
  async function request(method, path, body) {
    var opts = { method: method, headers: buildHeaders(!!body) };
    var err, data;
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(base + path, opts);
    try {
      data = await res.json();
    } catch (_e) {
      // Non-JSON response: server crash, proxy error page, captive portal,
      // misconfigured base URL, etc. Surface a structured error matching
      // the documented contract instead of a raw SyntaxError.
      err = new Error(`Legendum API error (HTTP ${res.status})`);
      err.code = `http_${res.status}`;
      err.status = res.status;
      throw err;
    }
    if (!data.ok) {
      err = new Error(data.message || data.error || "Legendum API error");
      err.code = data.error;
      err.status = res.status;
      throw err;
    }
    return data.data;
  }
  return { base: base, request: request };
}

// Single source of truth for the methods exposed on every service client
// (returned by create()), wrapped by client(), and re-exported at module
// level. If you add a method to create()'s return object, add it here too.
var ASYNC_METHODS = [
  "charge",
  "balance",
  "reserve",
  "requestLink",
  "pollLink",
  "waitForLink",
  "exchangeCode",
  "linkKey",
  "issueKey",
];
var SYNC_METHODS = ["authUrl", "authAndLinkUrl"];

// Template for the script body emitted by linkWidget(). Stored as a single
// constant so the source is readable instead of a 50-line `+` chain. Tokens
// (__ID__, __LEG_URL__, __LINK_URL__, __CONFIRM_URL__, __BUY_BTN__,
// __POLL_LINKED__, __INIT__) are substituted by linkWidget at call time.
// Output for fixed inputs is regression-tested (length + substrings) in test/sdk.test.ts.
var LINK_WIDGET_SCRIPT_TEMPLATE =
  '(function(){'
  + 'var el=document.getElementById("__ID__");'
  + 'var L="__LEG_URL__";'
  + 'function linked(bal){'
  +   'el.innerHTML=\'__BUY_BTN__\';'
  +   'if(typeof bal==="number"){'
  +     'var a=el.querySelector("a");'
  +     'if(a){var s=a.querySelector("span");if(s){s.style.borderRadius="999px";s.style.padding="0.15em 0.6em";s.style.width="auto";s.style.height="auto";s.textContent="\\u2C60 "+bal.toLocaleString();}}'
  +   '}'
  + '}'
  + 'function unlinked(){'
  +   'el.innerHTML=\'<button class="__ID__-btn" id="__ID__-sl"><span style="display:inline-flex;align-items:center;justify-content:center;width:1.5em;height:1.5em;border-radius:50%;background:rgb(88,176,209);color:white;font-weight:bold;font-size:0.9em;margin-right:0.5rem;">&#x2C60;</span>Pay with Legendum</button>\';'
  +   'document.getElementById("__ID__-sl").onclick=doLink;'
  + '}'
  + 'function doLink(){'
  +   'fetch("__LINK_URL__",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:"{}"})'
  +   '.then(function(r){return r.json();})'
  +   '.then(function(d){'
  +     'if(d.ok&&d.code){'
  +       'el.innerHTML=\'<p class="__ID__-wait" id="__ID__-ps">Opening Legendum to link your account…</p>\';'
  +       'poll(d.request_id);'
  +       'window.open(L+"/link?code="+encodeURIComponent(d.code),"_blank");'
  +     '}else{alert(d.message||d.error||"Failed to start linking");}'
  +   '}).catch(function(){alert("Connection error");});'
  + '}'
  + 'function poll(rid){'
  +   'var iv=setInterval(function(){'
  +     'fetch("__CONFIRM_URL__",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:rid})})'
  +     '.then(function(r){return r.json();})'
  +     '.then(function(d){'
  +       'if(d.ok&&d.status==="confirmed"){clearInterval(iv);__POLL_LINKED__'
  +       '}'
  +       'else if(d.ok&&d.status==="expired"){'
  +         'clearInterval(iv);'
  +         'var ps=document.getElementById("__ID__-ps");'
  +         'if(ps){ps.className="__ID__-err";ps.textContent="Code expired. Please try again.";}'
  +         'setTimeout(unlinked,3000);'
  +       '}'
  +     '}).catch(function(){});'
  +   '},3000);'
  +   'setTimeout(function(){clearInterval(iv);},600000);'
  + '}'
  + '__INIT__'
  + '})();';

function create(config) {
  const baseUrl = (config?.baseUrl) || readEnv("LEGENDUM_BASE_URL") || "https://legendum.co.uk";
  const apiKey = (config?.apiKey) || readEnv("LEGENDUM_API_KEY");
  const secret = (config?.secret) || readEnv("LEGENDUM_SECRET");

  if (!apiKey || !secret) {
    throw new Error("Legendum SDK: LEGENDUM_API_KEY and LEGENDUM_SECRET are required");
  }

  var transport = makeTransport(baseUrl, (json) => {
    var h = {
      "X-API-Key": apiKey,
      "Authorization": `Bearer ${secret}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  });
  var base = transport.base;
  var request = transport.request;

  return {
    /**
     * Charge credits from a linked account.
     * @param {string} accountToken - The account_service token
     * @param {number} amount - Credits to charge (positive integer)
     * @param {string} description - Human-readable description
     * @param {object} [opts] - Optional: { key, meta }
     * @returns {Promise<{ email: string, transaction_id: number, balance: number }>}
     */
    async charge(accountToken, amount, description, opts) {
      var body = {
        account_token: accountToken,
        amount: amount,
        description: description,
      };
      if (opts?.key) body.key = opts.key;
      if (opts?.meta) body.meta = opts.meta;
      return request("POST", "/api/charge", body);
    },

    /**
     * Get balance for a linked account.
     * @param {string} accountToken - The account_service token
     * @returns {Promise<{ balance: number, held: number }>}
     */
    async balance(accountToken) {
      return request(
        "GET",
        `/api/balance?account_token=${encodeURIComponent(accountToken)}`,
      );
    },

    /**
     * Reserve credits (hold for up to 15 minutes).
     * @param {string} accountToken - The account_service token
     * @param {number} amount - Credits to reserve
     * @param {string} [description] - Optional description
     * @returns {Promise<Reservation>}
     */
    async reserve(accountToken, amount, description) {
      var body = { account_token: accountToken, amount: amount };
      if (description) body.description = description;
      var data = await request("POST", "/api/reserve", body);
      return {
        id: data.reservation_id,
        amount: amount,
        /**
         * Settle the reservation (finalise the charge).
         * @param {number} [settleAmount] - Amount to settle (defaults to reserved amount)
         * @returns {Promise<{ email: string, transaction_id: number, balance: number }>}
         */
        async settle(settleAmount) {
          return request("POST", "/api/settle", {
            reservation_id: data.reservation_id,
            amount: settleAmount,
          });
        },
        /**
         * Release the reservation (cancel, no charge).
         */
        async release() {
          return request("POST", "/api/release", {
            reservation_id: data.reservation_id,
          });
        },
      };
    },

    /**
     * Request a pairing code for account linking.
     * @returns {Promise<{ code: string, request_id: string }>}
     */
    async requestLink() {
      return request("POST", "/api/link", {});
    },

    /**
     * Poll for a link request result.
     * @param {string} requestId - The request_id from requestLink()
     * @returns {Promise<{ status: string, account_token?: string }>}
     */
    async pollLink(requestId) {
      return request("GET", `/api/link/${encodeURIComponent(requestId)}`);
    },

    /**
     * Build a "Login with Legendum" authorize URL.
     * Redirect the user's browser here to start the auth flow.
     * @param {object} opts
     * @param {string} opts.redirectUri - Your callback URL (must be registered)
     * @param {string} opts.state - CSRF token (opaque string, returned unchanged)
     * @returns {string} The authorize URL
     */
    authUrl(opts) {
      return base + "/auth/authorize?client_id=" + encodeURIComponent(apiKey)
        + "&redirect_uri=" + encodeURIComponent(opts.redirectUri)
        + "&state=" + encodeURIComponent(opts.state);
    },

    /**
     * Build a "Login and link with Legendum" authorize URL (identity + service pairing in one flow).
     * Call after requestLink(); pass the returned pairing code as linkCode.
     * Redirect the user's browser here (backend must support intent=login_link).
     * @param {object} opts
     * @param {string} opts.redirectUri - Your callback URL (must be registered)
     * @param {string} opts.state - CSRF token (opaque string, returned unchanged)
     * @param {string} opts.linkCode - Pairing code from requestLink()
     * @returns {string} The authorize URL
     */
    authAndLinkUrl(opts) {
      if (!opts?.linkCode) {
        throw new Error("Legendum SDK: authAndLinkUrl requires linkCode");
      }
      return base + "/auth/authorize?client_id=" + encodeURIComponent(apiKey)
        + "&redirect_uri=" + encodeURIComponent(opts.redirectUri)
        + "&state=" + encodeURIComponent(opts.state)
        + "&intent=login_link"
        + "&link_code=" + encodeURIComponent(opts.linkCode);
    },

    /**
     * Exchange a one-time auth code for user info.
     * Call this server-side in your callback handler.
     * @param {string} code - The code from the redirect query string
     * @param {string} redirectUri - Must match the original authorize request
     * @returns {Promise<{ email: string, linked: boolean, account_token?: string }>}
     *   When `linked` is true, `account_token` is the opaque account-service token for charge/balance/reserve.
     */
    async exchangeCode(code, redirectUri) {
      return request("POST", "/api/auth/token", { code: code, redirect_uri: redirectUri });
    },

    /**
     * Link this service to a Legendum account using the user's account key (lak_…).
     * Creates the account-service link and returns the per-service `account_token`
     * you'll persist on the user row and pass to `charge` / `balance` / `reserve` / `tab`.
     * @param {string} accountKey - The account key (lak_...)
     * @returns {Promise<{ account_token: string, email: string }>}
     */
    async linkKey(accountKey) {
      return request("POST", "/api/agent/link-key", { api_key: apiKey, secret: secret, account_key: accountKey });
    },

    /**
     * Issue a Legendum Account Key for a user this service is already linked to.
     * Requires the calling service to have `can_issue_keys: true` in
     * services.yml. The returned `key` is shown once — store it (encrypted) and
     * pass it as `lak_…` to downstream services.
     * @param {string} accountToken - The caller's existing account_token for this user
     * @param {object} [opts] - { label }
     * @returns {Promise<{ key: string, key_prefix: string, label: string, id: number }>}
     * @throws err.code === "forbidden" (403) — service lacks `can_issue_keys` flag
     * @throws err.code === "unauthorized" (401) — bad service creds, or accountToken unknown / inactive / belongs to another service
     * @throws err.code === "rate_limited" (429) — too many issues for this (service, account) — currently 10/hour
     */
    async issueKey(accountToken, opts) {
      var body = { api_key: apiKey, secret: secret, account_token: accountToken };
      if (opts?.label) body.label = opts.label;
      return request("POST", "/api/agent/keys", body);
    },

    /**
     * Poll until link is confirmed or expired.
     * @param {string} requestId - The request_id from requestLink()
     * @param {object} [opts] - { interval: ms (default 2000), timeout: ms (default 600000) }
     * @returns {Promise<{ account_token: string }>}
     */
    async waitForLink(requestId, opts) {
      var interval = (opts?.interval) || 2000;
      var timeout = (opts?.timeout) || 600000;
      var deadline = Date.now() + timeout;
      var result;
      var err;
      while (Date.now() < deadline) {
        result = await this.pollLink(requestId);
        if (result.status === "confirmed") return result;
        if (result.status === "expired") {
          err = new Error("Link request expired");
          err.code = "link_expired";
          throw err;
        }
        await new Promise((r) => { setTimeout(r, interval); });
      }
      err = new Error("Link polling timed out");
      err.code = "timeout";
      throw err;
    },

    /**
     * Batched micro-charges (same as top-level {@link tab}, but uses this client for `charge`).
     * @param {string} accountToken
     * @param {string} description
     * @param {object} opts - { threshold, amount?, client? } — `client` defaults to this service client
     */
    tab(accountToken, description, opts) {
      return tab(accountToken, description, Object.assign({}, opts || {}, { client: this }));
    },
  };
}

/**
 * Create an account client for account-holder operations.
 * Uses an account key (lak_...) to act on behalf of a human user.
 *
 * @param {string} accountKey - The account key (lak_...)
 * @param {object} [config] - { baseUrl }
 * @returns {object} Account client with balance(), transactions(), link(), unlink() methods
 *
 * Example:
 *   const acct = legendum.account('lak_...');
 *   const { balance } = await acct.balance();
 *   await acct.link('ABC123');
 */
function account(accountKey, config) {
  var baseUrl = (config?.baseUrl) || readEnv("LEGENDUM_BASE_URL") || "https://legendum.co.uk";
  var transport = makeTransport(baseUrl, (json) => {
    var h = { "Authorization": `Bearer ${accountKey}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  });
  var request = transport.request;

  return {
    /** Get account identity (verified email). */
    async whoami() {
      return request("GET", "/api/agent/whoami");
    },

    /** Get account balance and linked services. */
    async balance() {
      return request("GET", "/api/agent/balance");
    },

    /** Get recent transactions. @param {number} [limit=20] */
    async transactions(limit) {
      return request("GET", `/api/agent/transactions?limit=${encodeURIComponent(limit || 20)}`);
    },

    /** Link to a service using a pairing code. @param {string} code */
    async link(code) {
      return request("POST", "/api/agent/link", { code: code });
    },

    /** Unlink from a service. @param {string} domain */
    async unlink(domain) {
      return request("DELETE", `/api/agent/link/${encodeURIComponent(domain)}`);
    },

    /**
     * Authorize with a third-party service (Login with Legendum, no browser).
     * @param {object} opts - { clientId, redirectUri, state }
     * @returns {Promise<{ code: string, redirect_uri: string, state: string }>}
     */
    async authorize(opts) {
      return request("POST", "/api/agent/authorize", {
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        state: opts.state,
      });
    },
  };
}

/**
 * Generate HTML for a "Buy Legendum Credits" button.
 * @param {object} [opts] - { url, label, target }
 * @returns {string} HTML string
 */
function button(opts) {
  var href = (opts?.url) || "https://legendum.co.uk/account";
  var label = (opts?.label) || "Buy Credits";
  var target = (opts?.target) || "_blank";
  return '<a href="' + href + '" target="' + target + '" style="display:inline-flex;align-items:center;gap:0.5rem;background:rgb(88,54,136);color:white;padding:0.6rem 1.2rem;border-radius:4px;text-decoration:none;font-size:1rem;font-family:system-ui,-apple-system,sans-serif;">'
    + '<span style="display:inline-flex;align-items:center;justify-content:center;width:1.5em;height:1.5em;border-radius:50%;background:rgb(88,176,209);color:white;font-weight:bold;font-size:0.9em;">&#x2C60;</span>'
    + label + '</a>';
}

/**
 * Generate HTML + JS for the full Legendum linking widget.
 * Drop this into any page to let users link their Legendum account.
 *
 * @param {object} opts
 * @param {string} [opts.mountAt]   - Prefix used with middleware() — auto-sets linkUrl, confirmUrl, statusUrl
 * @param {string} [opts.linkUrl]    - Your backend endpoint to start linking (POST, returns { ok, code, request_id })
 * @param {string} [opts.confirmUrl] - Your backend endpoint to poll/confirm (POST { request_id }, returns { ok, status })
 * @param {string} [opts.statusUrl]  - Your backend endpoint to check linked state (GET, returns { legendum_linked, balance? })
 * @param {string} [opts.baseUrl]  - Legendum base URL (default: https://legendum.co.uk)
 * @returns {string} HTML string (include directly in page, not via innerHTML)
 */
function linkWidget(opts) {
  var mount = opts.mountAt ? opts.mountAt.replace(/\/+$/, "") : null;
  var linkUrl = opts.linkUrl || (mount && `${mount}/link`);
  var confirmUrl = opts.confirmUrl || (mount && `${mount}/confirm`);
  var statusUrl = opts.statusUrl || (mount && `${mount}/status`) || null;
  var legUrl = (opts.baseUrl || "https://legendum.co.uk").replace(/\/+$/, "");
  var id = `lgw-${Math.random().toString(36).slice(2, 8)}`;
  var buyBtn = button({ url: `${legUrl}/account` });

  var pollLinkedFrag = statusUrl
    ? `fetch("${statusUrl}",{credentials:"include"}).then(function(r){return r.ok?r.json():null;}).then(function(s){linked(s&&s.balance);}).catch(function(){linked();});`
    : 'linked();';
  var initFrag = statusUrl
    ? `fetch("${statusUrl}",{credentials:"include"}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(d&&d.legendum_linked)linked(d.balance);else unlinked();}).catch(function(){unlinked();});`
    : 'unlinked();';

  // Substitution order matters: __BUY_BTN__ first (its replacement contains
  // none of the other tokens), then __ID__ (used many times), then the rest.
  var script = LINK_WIDGET_SCRIPT_TEMPLATE
    .replace(/__BUY_BTN__/g, buyBtn.replace(/'/g, "\\'"))
    .replace(/__POLL_LINKED__/g, pollLinkedFrag)
    .replace(/__INIT__/g, initFrag)
    .replace(/__LINK_URL__/g, linkUrl)
    .replace(/__CONFIRM_URL__/g, confirmUrl)
    .replace(/__LEG_URL__/g, legUrl)
    .replace(/__ID__/g, id);

  return '<div id="' + id + '"></div>'
    + '<style>'
    + '.' + id + '-btn{display:inline-block;background:rgb(88,54,136);color:white;padding:0.5rem 1rem;border-radius:4px;border:none;font-size:1rem;cursor:pointer;text-decoration:none;font-family:system-ui,-apple-system,sans-serif;}'
    + '.' + id + '-btn:hover{background:rgb(68,34,116);}'
    + '.' + id + '-ok{padding:0.75rem 1rem;background:rgba(88,176,209,0.1);border:1px solid rgba(88,176,209,0.4);border-radius:4px;margin-bottom:1rem;}'
    + '.' + id + '-wait{padding:0.75rem 1rem;background:rgba(188,171,122,0.15);border:1px solid rgba(188,171,122,0.4);border-radius:4px;}'
    + '.' + id + '-err{padding:0.75rem 1rem;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;}'
    + '</style>'
    + '<script>'
    + script
    + '</script>';
}

/**
 * Framework-agnostic link controller for reactive UIs (React, Vue, Svelte, etc).
 * Returns a state object and methods — no DOM or HTML generation.
 *
 * @param {object} opts
 * @param {string} [opts.mountAt]   - Prefix used with middleware() — auto-sets linkUrl, confirmUrl, statusUrl
 * @param {string} [opts.linkUrl]   - Backend endpoint to start linking (POST)
 * @param {string} [opts.confirmUrl]- Backend endpoint to poll/confirm (POST)
 * @param {string} [opts.statusUrl] - Backend endpoint to check linked state (GET)
 * @param {string} [opts.baseUrl]   - Legendum base URL (default: https://legendum.co.uk)
 * @param {object} [opts.client]   - SDK client from create() — for startAuthAndLink when not using middleware /auth-link
 * @param {string} [opts.authLinkUrl] - POST endpoint that returns { url } (default: mountAt + "/auth-link" when mountAt is set)
 * @param {string} [opts.redirectUri] - Your Login with Legendum callback URL (must be registered) — required for startAuthAndLink
 * @param {string} [opts.state]     - CSRF token for authorize — required for startAuthAndLink (or pass to startAuthAndLink(state))
 * @param {function} opts.onChange   - Called with (state) whenever state changes
 * @returns {{ getState, checkStatus, startLink, startAuthAndLink, accountUrl, destroy }}
 *
 * State shape: { status: "loading"|"unlinked"|"linking"|"linked"|"error", balance: number|null, error: string|null }
 *
 * Example (React):
 *   const [state, setState] = useState({ status: "loading", balance: null, error: null });
 *   const ctrlRef = useRef(null);
 *   useEffect(() => {
 *     const ctrl = legendum.linkController({ mountAt: "/legendum", onChange: setState });
 *     ctrlRef.current = ctrl;
 *     ctrl.checkStatus();
 *     return () => ctrl.destroy();
 *   }, []);
 *   // Render based on state.status, call ctrlRef.current.startLink() on button click
 *
 * Login + link in one flow (redirects the browser to Legendum authorize):
 *   // With middleware (API key only on server): mountAt auto-sets POST …/auth-link
 *   const ctrl = legendum.linkController({
 *     mountAt: "/legendum",
 *     onChange: setState,
 *     redirectUri: "https://myapp.com/auth/callback",
 *     state: csrfToken,
 *   });
 *   ctrl.startAuthAndLink();
 *
 *   // Or pass a client from create() and use /link + authAndLinkUrl in the browser:
 *   const ctrl2 = legendum.linkController({ mountAt: "/legendum", onChange: setState, client: legendum.create({ apiKey, secret }), redirectUri, state });
 */
function linkController(opts) {
  var mount = opts.mountAt ? opts.mountAt.replace(/\/+$/, "") : null;
  var linkUrl = opts.linkUrl || (mount && `${mount}/link`);
  /** Default POST …/auth-link when mountAt is set; set to `null` to use opts.client + POST …/link + authAndLinkUrl in the browser instead. */
  var authLinkUrl = opts.authLinkUrl !== undefined ? opts.authLinkUrl : mount && `${mount}/auth-link`;
  var confirmUrl = opts.confirmUrl || (mount && `${mount}/confirm`);
  var statusUrl = opts.statusUrl || (mount && `${mount}/status`) || null;
  var legUrl = (opts.baseUrl || "https://legendum.co.uk").replace(/\/+$/, "");
  var sdkClient = opts.client;
  var onChange = opts.onChange || (() => {});
  var pollTimer = null;
  var pollTimeout = null;
  var pollFailures = 0;
  var destroyed = false;

  var state = { status: "loading", balance: null, error: null };

  /** Parse JSON or `{}` when the body is not JSON. */
  function readJsonBody(r) {
    return r.json().catch(() => ({}));
  }

  function setState(patch) {
    for (var k in patch) state[k] = patch[k];
    if (!destroyed) onChange({ status: state.status, balance: state.balance, error: state.error });
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
  }

  // After surfacing an error to the consumer, drop back to "unlinked" so
  // the user can try again. 3s gives the UI time to display the message.
  function resetSoon() {
    setTimeout(() => {
      if (!destroyed) setState({ status: "unlinked" });
    }, 3000);
  }

  function checkStatus() {
    if (!statusUrl) { setState({ status: "unlinked" }); return; }
    fetch(statusUrl, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.legendum_linked) setState({ status: "linked", balance: typeof d.balance === "number" ? d.balance : null });
        else setState({ status: "unlinked", balance: null });
      })
      .catch(() => { setState({ status: "unlinked", balance: null }); });
  }

  function startLink() {
    if (state.status === "linking") return;
    setState({ status: "linking", error: null });
    fetch(linkUrl, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (r) => {
        var d = await readJsonBody(r);
        if (!r.ok) {
          setState({
            status: "error",
            error: d.message || d.error || (`Link failed (${r.status})`),
          });
          resetSoon();
          return;
        }
        if (d.ok && d.code) {
          window.open(`${legUrl}/link?code=${encodeURIComponent(d.code)}`, "_blank");
          poll(d.request_id);
        } else {
          setState({
            status: "error",
            error: d.message || d.error || "Failed to start linking",
          });
          resetSoon();
        }
      })
      .catch(() => {
        setState({ status: "error", error: "Connection error" });
        resetSoon();
      });
  }

  /**
   * Login and link in one step: request a pairing code, then redirect to Legendum authorize
   * (same query shape as authAndLinkUrl). Full-page navigation — no polling (user returns via callback).
   * @param {string} [csrfState] - Overrides opts.state for this call (e.g. fresh token per click)
   */
  function startAuthAndLink(csrfState) {
    if (state.status === "linking") return;
    var redirectUri = opts.redirectUri;
    var csrf = csrfState !== undefined ? csrfState : opts.state;
    if (!redirectUri) {
      throw new Error("Legendum SDK: linkController startAuthAndLink requires opts.redirectUri");
    }
    if (csrf === undefined || csrf === null) {
      throw new Error("Legendum SDK: linkController startAuthAndLink requires opts.state or startAuthAndLink(state)");
    }
    setState({ status: "linking", error: null });

    if (authLinkUrl) {
      fetch(authLinkUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uri: redirectUri, state: String(csrf) }),
      })
        .then(async (r) => {
          var d = await readJsonBody(r);
          if (!r.ok) {
            setState({
              status: "error",
              error: d.message || d.error || (`Login and link failed (${r.status})`),
            });
            resetSoon();
            return;
          }
          if (d.ok && d.url) {
            window.location.assign(d.url);
          } else {
            setState({
              status: "error",
              error: d.message || d.error || "Failed to start login and link",
            });
            resetSoon();
          }
        })
        .catch(() => {
          setState({ status: "error", error: "Connection error" });
          resetSoon();
        });
      return;
    }

    if (!sdkClient || typeof sdkClient.authAndLinkUrl !== "function") {
      throw new Error(
        "Legendum SDK: linkController startAuthAndLink requires opts.authLinkUrl / mountAt (middleware), or opts.client from legendum.create()"
      );
    }
    if (!linkUrl) {
      throw new Error("Legendum SDK: linkController startAuthAndLink requires linkUrl or mountAt when using opts.client");
    }
    fetch(linkUrl, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (r) => {
        var d = await readJsonBody(r);
        var url;
        if (!r.ok) {
          setState({
            status: "error",
            error: d.message || d.error || (`Link failed (${r.status})`),
          });
          resetSoon();
          return;
        }
        if (d.ok && d.code) {
          url = sdkClient.authAndLinkUrl({
            redirectUri: redirectUri,
            state: String(csrf),
            linkCode: d.code,
          });
          window.location.assign(url);
        } else {
          setState({
            status: "error",
            error: d.message || d.error || "Failed to start linking",
          });
          resetSoon();
        }
      })
      .catch(() => {
        setState({ status: "error", error: "Connection error" });
        resetSoon();
      });
  }

  function poll(requestId) {
    stopPolling();
    pollFailures = 0;
    pollTimer = setInterval(() => {
      if (destroyed) { stopPolling(); return; }
      fetch(confirmUrl, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId }) })
        .then(async (r) => {
          var d = await readJsonBody(r);
          if (!r.ok) {
            pollFailures++;
            if (pollFailures >= 2) {
              stopPolling();
              setState({
                status: "error",
                error: d.message || d.error || (`Confirm failed (${r.status})`),
              });
              resetSoon();
            }
            return;
          }
          if (d.ok && d.status === "confirmed") {
            pollFailures = 0;
            stopPolling();
            checkStatus();
          } else if (d.ok && d.status === "expired") {
            pollFailures = 0;
            stopPolling();
            setState({ status: "error", error: "Code expired. Please try again." });
            resetSoon();
          } else if (!d.ok) {
            pollFailures++;
            if (pollFailures >= 2) {
              stopPolling();
              setState({
                status: "error",
                error: d.message || d.error || "Could not confirm link.",
              });
              resetSoon();
            }
          } else {
            pollFailures = 0;
          }
        })
        .catch(() => {
          pollFailures++;
          if (pollFailures >= 2) {
            stopPolling();
            setState({ status: "error", error: "Connection error while confirming link." });
            resetSoon();
          }
        });
    }, 3000);
    pollTimeout = setTimeout(() => { stopPolling(); if (!destroyed) setState({ status: "unlinked" }); }, 600000);
  }

  return {
    getState: () => ({ status: state.status, balance: state.balance, error: state.error }),
    checkStatus: checkStatus,
    startLink: startLink,
    startAuthAndLink: startAuthAndLink,
    /** URL for the buy credits / account page */
    accountUrl: `${legUrl}/account`,
    destroy: () => { destroyed = true; stopPolling(); }
  };
}

/**
 * Create middleware that handles Legendum linking routes.
 * Works with any server that uses Web Standard Request/Response (Bun, Deno, Cloudflare Workers, etc).
 *
 * @param {object} opts
 * @param {string} [opts.prefix]       - URL prefix for routes (default: "/legendum")
 * @param {function} opts.getToken     - async (request, ...extra) => string|null — return the stored account_token for the current user, or null
 * @param {function} opts.setToken     - async (request, accountToken, ...extra) => void — save the account_token for the current user
 * @param {function} [opts.clearToken] - async (request, ...extra) => void — optional; called when balance() returns token_not_found (e.g. clear stored token). Same extra args as getToken/setToken.
 * @param {function} [opts.onLink] - async (request, accountToken, email, ...extra) => void — optional; called right after setToken succeeds in /confirm. Use for "user just linked" side effects like sending a welcome email or refreshing a session. `email` is the verified Legendum account email (string, may be null in edge cases). Errors thrown here are swallowed (best-effort) so a failing side effect can't break the link flow.
 * @param {function} [opts.onLinkKey] - async (request, accountToken, email, ...extra) => void — optional; after successful /link-key (same contract as onLink; errors swallowed).
 * @param {function} [opts.onIssueKey] - async (request, key, keyPrefix, ...extra) => void — optional; called right after /issue-key issues a fresh `lak_…` for the current user. Use to encrypt-and-store the key. The raw key is passed once. Errors are swallowed (best-effort).
 * @param {object} [opts.client]       - SDK client from create(). If omitted, uses default (env vars)
 * @returns {function} async (request, ...extra) => Response|null — returns Response if handled, null if not a Legendum route. Extra args are passed through to callbacks.
 *
 * Routes created:
 *   POST {prefix}/link       — request a pairing code
 *   POST {prefix}/auth-link  — request pairing code + build login-and-link authorize URL (body: { redirect_uri, state })
 *   POST {prefix}/link-key   — Bearer lak_ → { account_token, email }
 *   POST {prefix}/issue-key  — issue a fresh lak_ for the current user (requires getToken)
 *   POST {prefix}/confirm    — poll for link confirmation
 *   GET  {prefix}/status     — check linked state and balance
 *
 * Usage with linkWidget:
 *   linkWidget({ mountAt: "/legendum" })
 *   // Automatically sets linkUrl, confirmUrl, statusUrl
 */
function middleware(opts) {
  var prefix = (opts.prefix || "/legendum").replace(/\/+$/, "");
  var getToken = opts.getToken;
  var setToken = opts.setToken;
  var clearToken = opts.clearToken || (async () => {});
  var onLink = opts.onLink || null;
  var onLinkKey = opts.onLinkKey || null;
  var onIssueKey = opts.onIssueKey || null;
  var client = opts.client || null;

  function getClient() {
    if (!client) client = create();
    return client;
  }

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** @param {string} message @param {number} status @param {string} [error] */
  function errorJson(message, status, error) {
    var o = { ok: false, message: message };
    if (error) o.error = error;
    return jsonResponse(o, status);
  }

  /** @param {{ message?: string, code?: string }} err @param {number} status @param {string} [fallbackError] */
  function errorFromCaught(err, status, fallbackError) {
    var code = err?.code || fallbackError;
    var msg = err?.message || "Legendum error";
    return errorJson(msg, status, code);
  }

  return async (request, ...extra) => {
    var url = new URL(request.url);
    var path = url.pathname;
    var route, c, body, data, redirectUri, st, linkData, authUrl, token;
    var authHeader, bearer, httpStatus, s;

    if (!path.startsWith(`${prefix}/`) && path !== prefix) return null;
    route = path.slice(prefix.length);

    // POST /link
    if (route === "/link" && request.method === "POST") {
      try {
        c = getClient();
        data = await c.requestLink();
        return jsonResponse({ ok: true, code: data.code, request_id: data.request_id });
      } catch (err) {
        return errorFromCaught(err, 500, "internal");
      }
    }

    // POST /auth-link — pairing code + authorize URL for login-and-link (server holds API secret)
    if (route === "/auth-link" && request.method === "POST") {
      try {
        body = await request.json();
        redirectUri = body.redirect_uri || body.redirectUri;
        st = body.state;
        if (!redirectUri || st === undefined || st === null) {
          return errorJson("redirect_uri and state are required", 400, "bad_request");
        }
        c = getClient();
        linkData = await c.requestLink();
        authUrl = c.authAndLinkUrl({
          redirectUri: redirectUri,
          state: String(st),
          linkCode: linkData.code,
        });
        return jsonResponse({ ok: true, url: authUrl, request_id: linkData.request_id });
      } catch (err) {
        return errorFromCaught(err, 500, "internal");
      }
    }

    // POST /link-key
    if (route === "/link-key" && request.method === "POST") {
      try {
        authHeader = request.headers.get("Authorization") || "";
        bearer = /^Bearer\s+(\S+)/i.exec(authHeader);
        if (!bearer?.[1]) {
          return errorJson("Authorization: Bearer <account_key> required", 401, "unauthorized");
        }
        c = getClient();
        data = await c.linkKey(bearer[1]);
        if (onLinkKey) {
          try {
            await onLinkKey.apply(null, [request, data.account_token, data.email || null].concat(extra));
          } catch (_e) {
            /* best-effort: a failing onLinkKey side effect must not break the response */
          }
        }
        return jsonResponse({
          account_token: data.account_token,
          email: data.email,
        });
      } catch (err) {
        httpStatus = err.status;
        if (httpStatus === 401 || err.code === "unauthorized") {
          return errorFromCaught(err, 401, "unauthorized");
        }
        if (httpStatus >= 400 && httpStatus < 500) {
          return errorFromCaught(err, httpStatus, "bad_request");
        }
        return errorFromCaught(err, 500, "internal");
      }
    }

    // POST /issue-key
    if (route === "/issue-key" && request.method === "POST") {
      try {
        body = await request.json().catch(() => ({}));
        token = await getToken.apply(null, [request].concat(extra));
        if (!token) return errorJson("no_link", 409, "no_link");
        c = getClient();
        data = await c.issueKey(token, { label: body.label });
        if (onIssueKey) {
          try {
            await onIssueKey.apply(null, [request, data.key, data.key_prefix].concat(extra));
          } catch (_e) {
            /* best-effort: a failing onIssueKey side effect must not break the response */
          }
        }
        return jsonResponse({
          key: data.key,
          key_prefix: data.key_prefix,
          label: data.label,
          id: data.id,
        });
      } catch (err) {
        s = err.status;
        if (s < 400 || s >= 600 || typeof s !== "number") s = 500;
        return errorFromCaught(err, s, s >= 500 ? "internal" : "bad_request");
      }
    }

    // POST /confirm
    if (route === "/confirm" && request.method === "POST") {
      try {
        body = await request.json();
        if (!body.request_id) return errorJson("request_id is required", 400, "bad_request");
        c = getClient();
        data = await c.pollLink(body.request_id);
        if (data.status === "confirmed" && data.account_token) {
          await setToken.apply(null, [request, data.account_token].concat(extra));
          if (onLink) {
            try {
              await onLink.apply(null, [request, data.account_token, data.email || null].concat(extra));
            } catch (_e) {
              /* best-effort: a failing onLink side effect must not break the link flow */
            }
          }
          return jsonResponse({ ok: true, status: "confirmed" });
        }
        return jsonResponse({ ok: true, status: data.status });
      } catch (err) {
        return errorFromCaught(err, err.status || 500, "internal");
      }
    }

    // GET /status
    if (route === "/status" && request.method === "GET") {
      token = await getToken.apply(null, [request].concat(extra));
      if (!token) return jsonResponse({ legendum_linked: false });
      try {
        c = getClient();
        data = await c.balance(token);
        return jsonResponse({ legendum_linked: true, balance: data.balance });
      } catch (err) {
        if (err.code === "token_not_found") {
          try {
            await clearToken.apply(null, [request].concat(extra));
          } catch (_e) {
            /* still return unlinked — clearing storage is best-effort */
          }
          return jsonResponse({ legendum_linked: false });
        }
        return jsonResponse({ legendum_linked: true });
      }
    }

    return null;
  };
}

/**
 * Wrap a client so that every method returns { ok, data?, error?, code? }
 * instead of throwing on failure.
 * @param {object} [client] - A client from create(). If omitted, uses default (env vars)
 * @returns {object} Safe client: async methods return `{ ok, data?, error?, code? }`; `tab` is sync and returns `{ ok, data?, error?, code? }`; URL helpers return strings unchanged.
 */
function client(client) {
  var c = client || getDefault();
  var wrap = (fn) => async (...args) => {
    try {
      return { ok: true, data: await fn.apply(c, args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  };
  var wrapSync = (fn) => (...args) => {
    try {
      return { ok: true, data: fn.apply(c, args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  };
  var safe = {
    tab: wrapSync((accountToken, description, opts) => typeof c.tab === "function"
        ? c.tab(accountToken, description, opts)
        : tab(accountToken, description, Object.assign({}, opts || {}, { client: c }))),
  };
  ASYNC_METHODS.forEach((name) => { safe[name] = wrap(c[name]); });
  SYNC_METHODS.forEach((name) => { safe[name] = c[name].bind(c); });
  return safe;
}

/**
 * Create a tab that accumulates micro-charges and flushes when a threshold is reached.
 *
 * @param {string} accountToken - The account_service token
 * @param {string} description - Description for the batched charge
 * @param {object} opts
 * @param {number} opts.threshold - Flush when accumulated total reaches this amount (required)
 * @param {number} [opts.amount=1] - Default amount per add() call
 * @param {object} [opts.client] - SDK client from create(). If omitted, uses default (env vars)
 * @returns {Tab}
 *
 * Example:
 *   const tab = legendum.tab(token, "AI tokens", { threshold: 100 });
 *   tab.add();      // +1
 *   tab.add(5);     // +5
 *   await tab.close(); // flush remainder
 */
function tab(accountToken, description, opts) {
  if (!opts || typeof opts.threshold !== "number" || opts.threshold <= 0) {
    throw new Error("Legendum SDK: tab() requires opts.threshold (positive number)");
  }
  var threshold = opts.threshold;
  var defaultAmount = (opts?.amount) || 1;
  var c = (opts?.client) || getDefault();
  var total = 0;
  var flushing = null;
  var closed = false;

  async function flush() {
    // Floor — never round up (avoid charging users for credits they didn't consume).
    // Fractional remainder stays in `total` for the next flush; any sub-credit dust
    // at close() is dropped.
    var whole = Math.floor(total + 1e-9);
    if (whole <= 0) return;
    total -= whole;
    try {
      await c.charge(accountToken, whole, description);
    } catch (e) {
      // Roll back so the caller can retry without losing the units.
      total += whole;
      throw e;
    }
  }

  return {
    /** Current unflushed total. */
    get total() { return total; },

    /**
     * Add to the running total. Flushes automatically when threshold is reached.
     * @param {number} [amount] - Amount to add (defaults to opts.amount, which defaults to 1)
     * @returns {Promise<void>} Resolves after flush if one was triggered
     */
    async add(amount) {
      if (closed) throw new Error("Legendum SDK: tab is closed");
      var n = (amount !== undefined ? amount : defaultAmount);
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
        throw new Error("Legendum SDK: tab.add() requires a positive finite number");
      }
      total += n;
      if (total >= threshold && !flushing) {
        flushing = flush().finally(() => { flushing = null; });
        await flushing;
      }
    },

    /**
     * Flush any remaining balance without closing the tab. The tab remains
     * usable — further add() calls are allowed. Useful for periodic settlement
     * of partial balances that sit below the threshold.
     * @returns {Promise<void>}
     */
    async flush() {
      if (closed) throw new Error("Legendum SDK: tab is closed");
      if (flushing) { await flushing; return; }
      flushing = flush().finally(() => { flushing = null; });
      await flushing;
    },

    /**
     * Flush any remaining balance and close the tab. No further add() calls allowed.
     * @returns {Promise<void>}
     */
    async close() {
      if (closed) return;
      closed = true;
      if (flushing) await flushing;
      await flush();
    },
  };
}

// Default instance reads from env
var defaultClient = null;
var _mockClient = null;

function getDefault() {
  if (_mockClient) return _mockClient;
  if (!defaultClient) defaultClient = create();
  return defaultClient;
}

/**
 * Enable mock mode for testing. All SDK methods will use the provided
 * handlers instead of making HTTP calls. isConfigured() returns true.
 *
 * Each handler receives the same arguments as the real method and should
 * return what the real method would (or throw to simulate errors).
 *
 * @param {object} [handlers] - Optional overrides for any of: charge, balance, reserve, requestLink,
 *   pollLink, waitForLink, exchangeCode, linkKey, issueKey, authUrl, authAndLinkUrl, tab.
 *   Omitted keys use built-in defaults.
 *
 * Example:
 *   const legendum = require('./legendum.js');
 *   legendum.mock({
 *     charge: (token, amount, desc) => ({ email: "mock@test.com", transaction_id: 1, balance: 50 }),
 *     balance: (token) => ({ balance: 100, held: 0 }),
 *   });
 *   // ... run tests ...
 *   legendum.unmock();
 */
function mockSdk(handlers) {
  var h = handlers || {};
  var m = {
    charge: h.charge || (async () => ({ email: "mock@test.com", transaction_id: 1, balance: 0 })),
    balance: h.balance || (async () => ({ balance: 0, held: 0 })),
    reserve: h.reserve || (async (_t, amount) => ({ id: 1, amount: amount, settle: async () => {}, release: async () => {} })),
    requestLink: h.requestLink || (async () => ({ code: "MOCK", request_id: "mock_req" })),
    pollLink: h.pollLink || (async () => ({ status: "pending" })),
    waitForLink: h.waitForLink || (async () => ({ account_token: "mock_token" })),
    authUrl: h.authUrl || ((opts) => `http://mock.legendum.test/auth/authorize?state=${opts?.state || ""}`),
    authAndLinkUrl: h.authAndLinkUrl || ((opts) => "http://mock.legendum.test/auth/authorize?state=" + (opts?.state || "")
        + "&intent=login_link&link_code=" + encodeURIComponent((opts?.linkCode) || "")),
    exchangeCode: h.exchangeCode || (async () => ({ email: "mock@test.com", linked: false })),
    linkKey: h.linkKey || (async () => ({
      account_token: "mock_account_token",
      email: "mock@test.com",
    })),
    issueKey: h.issueKey || (async (_t, opts) => ({
      key: "lak_mock0000000000000000000000000000",
      key_prefix: "lak_mock0000",
      label: opts?.label || "mock",
      id: 1,
    })),
  };
  m.tab = h.tab || ((accountToken, description, opts) => tab(accountToken, description, Object.assign({}, opts || {}, { client: m })));
  _mockClient = m;
}

/**
 * Disable mock mode. Restores normal SDK behaviour.
 */
function unmockSdk() {
  _mockClient = null;
}

var sdk = {
  create: create,
  service: create,
  account: account,
  client: client,
  isConfigured: () => { if (_mockClient) return true; try { getDefault(); return true; } catch (_e) { return false; } },
  tab: tab,
  button: button,
  linkWidget: linkWidget,
  linkController: linkController,
  middleware: middleware,
  mock: mockSdk,
  unmock: unmockSdk,
  version: "1.0.0",
};
// Build the top-level facade methods from the same lists used by client().
// Each delegates to the default (env-configured) client; preserves existing
// behaviour where the default is lazily created on first use.
ASYNC_METHODS.forEach((name) => {
  sdk[name] = (...args) => {
    var d = getDefault();
    return d[name].apply(d, args);
  };
});
SYNC_METHODS.forEach((name) => {
  sdk[name] = (opts) => getDefault()[name](opts);
});
module.exports = sdk;
