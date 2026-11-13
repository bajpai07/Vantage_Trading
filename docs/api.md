# API (M2)

Backend only. JSON, camelCase. **All money fields are canonical decimal strings** (at least two decimals, e.g. `"10000.00"`, `"8099.5985"`), never numbers. Every error uses one envelope:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "requestId": "…"
  }
}
```

No stack trace, SQL or internal text is ever returned or logged. Each response carries `x-request-id` (an incoming `x-request-id` is reused only if it matches `^[A-Za-z0-9._-]{8,64}$`, otherwise a UUIDv7 is generated).

## Endpoints

| Method and path          | Auth    | Success                       | Notes                                                                                    |
| ------------------------ | ------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /health`            | none    | `200 {"status":"ok"}`         | Liveness. Touches nothing.                                                               |
| `GET /health/ready`      | none    | `200 {"status":"ready"}`      | Runs `SELECT 1`. `503 NOT_READY` if the database is unreachable.                         |
| `POST /v1/auth/register` | none    | `201` + `MeResponse` + cookie | One database transaction: user, MAIN account, ledger accounts, GRANT, session.           |
| `POST /v1/auth/login`    | none    | `200` + `MeResponse` + cookie | Always creates a new session.                                                            |
| `POST /v1/auth/logout`   | cookie  | `204` + cleared cookie        | Revokes the current session if valid. Always clears the cookie.                          |
| `GET /v1/me`             | session | `200` `MeResponse`            |                                                                                          |
| `GET /v1/account`        | session | `200` `AccountResponse`       | The caller's own MAIN account only (no account id is accepted). Needs `status = ACTIVE`. |

### Shapes (schemas live in `@vantage/contracts`)

- `RegisterRequest`: `email` (trimmed, valid, max 254; stored as given), `password` (10 to 128 characters, must not equal the email), `displayName` (2 to 40 characters after trimming), `countryCode` (ISO 3166-1 alpha-2 from the bundled list, upper-cased), `confirmAdult: true`, `acceptTerms: true`. Unknown fields are rejected.
- `LoginRequest`: `email`, `password`.
- `MeResponse`: `id`, `email`, `displayName`, `countryCode`, `role`, `status`.
- `AccountResponse`: `currency: "USD"`, `cash`, `equity` (equals cash until positions exist), `initialCapital`, `asOf` (server time, ISO 8601).

## Error codes

| HTTP | code                  | When                                                                    |
| ---- | --------------------- | ----------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`    | Body failed validation. The message names the fields, never the values. |
| 400  | `BAD_REQUEST`         | Malformed JSON.                                                         |
| 401  | `UNAUTHENTICATED`     | Missing, tampered, expired, idle or revoked session.                    |
| 401  | `INVALID_CREDENTIALS` | Wrong password **or** unknown email (identical response).               |
| 403  | `CSRF_REJECTED`       | State-changing request without the right `Origin`/`Referer`.            |
| 403  | `ACCOUNT_NOT_ACTIVE`  | `/v1/account` for a user whose status is not `ACTIVE`.                  |
| 404  | `NOT_FOUND`           | Unknown route or missing account.                                       |
| 409  | `EMAIL_TAKEN`         | Registration with an existing email (case-insensitive).                 |
| 413  | `PAYLOAD_TOO_LARGE`   | JSON body over 100 KB.                                                  |
| 429  | `RATE_LIMITED`        | A rate limit was hit. `Retry-After` gives the seconds to wait.          |
| 500  | `INTERNAL_ERROR`      | Anything unexpected. Nothing is leaked.                                 |
| 503  | `NOT_READY`           | Readiness check failed.                                                 |

## Session cookie

`vantage_session`: 32 random bytes, base64url. Only its SHA-256 is stored. Attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` = `SESSION_ABSOLUTE_DAYS` (default 7 days), `Secure` when `COOKIE_SECURE=true` (the default; `false` is accepted only for `APP_ENV` `local` or `test`).

A session is rejected when it is revoked, past `expires_at` (absolute limit), or idle for more than `SESSION_IDLE_MINUTES` (default 480). `last_seen_at` is written at most once a minute, so activity slides the idle window. The client IP and user agent are stored with the session.

## CSRF

Every `POST`, `PUT`, `PATCH` and `DELETE` must carry an `Origin` header equal to `WEB_ORIGIN`; if `Origin` is absent, the origin of the `Referer` must equal it. Otherwise `403 CSRF_REJECTED`. Together with `SameSite=Lax` this is the CSRF defence. CORS allows only `WEB_ORIGIN`, with credentials.

## Rate limits (in memory)

| What          | Limit             | Key                    |
| ------------- | ----------------- | ---------------------- |
| Failed logins | 5 per 15 minutes  | (IP, normalised email) |
| Failed logins | 20 per 15 minutes | IP                     |
| Registrations | 10 per hour       | IP                     |

Exceeding a limit returns `429` with `Retry-After`. **Limitations:** counters live in the memory of one API process (several processes each count separately, a restart clears them), and the IP is the socket peer address: `X-Forwarded-For` is **not** trusted and no trusted-proxy setting exists yet, so behind a reverse proxy every client would share the proxy's address until that setting is built.

## Login and registration behaviour worth knowing

- Wrong password and unknown email return the same status, code and message, and both run one Argon2id verification (unknown emails verify a dummy hash), so neither the response nor the work reveals which case it was.
- Registration with an existing email returns `409 EMAIL_TAKEN` (an accepted trade-off until email verification exists).
- Passwords are hashed with Argon2id (19 MiB memory, time cost 2, parallelism 1; one constant in `password.hasher.ts`). Hashes are stored as the encoded `$argon2id$…` string.
- D-42: new users are `ACTIVE` with `email_verified_at = NULL`; verification arrives in M8.
- Audit rows (`audit_logs`, append-only): `USER_REGISTERED`, `LOGIN_SUCCEEDED`, `LOGIN_FAILED` (email only as a 12-character SHA-256 prefix), `LOGOUT`. A failed audit write is logged and never blocks the request.

## Running locally

See the README quickstart: `node --env-file=.env apps/api/dist/main.js` after `pnpm build`. `--check` validates the configuration only (exit 0 ok, 2 invalid, 64 usage error).

## Instruments, quotes, market status and watchlists (M3a)

All of these need a valid session. Prices are canonical decimal strings. **A quote is never a bare price:** every quote item carries `source` and `freshness`. In local and test the source is `FIXTURE` (synthetic data); see [market-data.md](market-data.md).

| Method and path                           | Success                   | Notes                                                                                                                                   |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/instruments/search?q=`           | `200 { results }`         | `q` 1 to 40 characters after trimming, at most 20 results. Exact symbol first, then prefix, then typo-tolerant trigram similarity.      |
| `GET /v1/instruments/:symbol`             | `200` instrument          | `404 INSTRUMENT_NOT_FOUND`; `400` for a malformed symbol.                                                                               |
| `GET /v1/quotes?symbols=A,B`              | `200 { quotes }`          | 1 to 50 symbols, upper-cased and de-duplicated, one item per symbol in request order. Unknown symbols are reported with `known: false`. |
| `GET /v1/market/status`                   | `200 { asOf, exchanges }` | Per exchange: `state` OPEN or CLOSED, `session`, `reason`, holiday `note`, `nextOpen`, `nextClose`.                                     |
| `GET /v1/watchlists`                      | `200 { watchlists }`      | The caller's lists with their items (symbols only; ask `/v1/quotes` for prices).                                                        |
| `POST /v1/watchlists`                     | `201` watchlist           | `{ name }`, 1 to 40 characters, unique per user (`409 WATCHLIST_NAME_TAKEN`); at most 20 lists (`409 WATCHLIST_LIMIT`).                 |
| `PATCH /v1/watchlists/:id`                | `200` watchlist           | `{ name? , position? }` (at least one): rename or reorder lists.                                                                        |
| `DELETE /v1/watchlists/:id`               | `204`                     | Deletes the list and its items.                                                                                                         |
| `POST /v1/watchlists/:id/items`           | `201` or `200`            | `{ symbol }`. **201** when added, **200** when it was already there (idempotent). At most 100 items (`409 WATCHLIST_FULL`).             |
| `PUT /v1/watchlists/:id/items/order`      | `200` watchlist           | `{ symbols }` must be exactly the current symbols in the new order (`400 ORDER_MISMATCH`).                                              |
| `DELETE /v1/watchlists/:id/items/:symbol` | `204`                     | Idempotent: removing a symbol that is not in the list is also `204`.                                                                    |

A user can only see and change their own lists. Another user's list, an unknown list and a malformed list id all return `404 WATCHLIST_NOT_FOUND` (never 403). The CSRF Origin rule applies to every POST, PUT, PATCH and DELETE.

### Instrument item

`symbol`, `name`, `assetClass`, `exchange` (MIC, e.g. `XNAS`), `currency`, `status`, `tickSize`, `entitlement` (`REAL_TIME` or `DELAYED`), `delaySeconds`, `source` (e.g. `FIXTURE`).

### Quote item

`symbol`, `known`, `freshness` (`REAL_TIME`, `DELAYED`, `STALE`, `CLOSED`, `UNAVAILABLE`), `source`, `entitlement`, `delaySeconds`, `ageSeconds`, `asOf` (provider timestamp), and, **unless the freshness is `UNAVAILABLE`**, `bid`, `ask` and `last` (canonical strings). An `UNAVAILABLE` item has no price fields at all. `gapConfirmed: true` marks a price that jumped more than 10% and was confirmed by a second tick. `CLOSED` means the market is closed and the price is the last close.

### New error codes

| HTTP | code                   | When                                                  |
| ---- | ---------------------- | ----------------------------------------------------- |
| 404  | `INSTRUMENT_NOT_FOUND` | Unknown symbol (instrument or watchlist item).        |
| 404  | `WATCHLIST_NOT_FOUND`  | Unknown list, another user's list, malformed list id. |
| 409  | `WATCHLIST_NAME_TAKEN` | The user already has a list with that name.           |
| 409  | `WATCHLIST_LIMIT`      | 20 lists per user.                                    |
| 409  | `WATCHLIST_FULL`       | 100 items per list.                                   |
| 400  | `ORDER_MISMATCH`       | Item reorder does not list exactly the current items. |

## Orders and positions (M4b)

Market orders only (BUY and SELL, whole shares, USD), filled synchronously (D-30). All routes need a valid session; `POST` also needs the CSRF `Origin` rule. The account is always the session user's MAIN account: **no account id appears in any URL or body**.

| Method and path      | Success                      | Notes                                                                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/orders`    | `201` `OrderResponse`        | Needs the `Idempotency-Key` header. The order is `FILLED` or `REJECTED` (a business reject is **not** an HTTP error). |
| `GET /v1/orders/:id` | `200` `OrderResponse`        | `404 ORDER_NOT_FOUND` for an unknown id, a malformed id and **another user's order** (never 403).                     |
| `GET /v1/orders`     | `200 { orders, nextCursor }` | Newest first (`created_at`, then `id`), cursor pagination, filters `status`, `symbol`.                                |
| `GET /v1/positions`  | `200 { positions }`          | Open positions from the positions cache: `symbol`, `qty`, `avgCost`. No market value and no P&L yet (M5).             |

### POST /v1/orders

Request (exactly these fields; unknown fields such as `accountId`, `price`, `fee` or `now` are `400 VALIDATION_ERROR`):

```http
POST /v1/orders
Origin: http://localhost:3000
Idempotency-Key: 4f0c2d9e-order-0001
Content-Type: application/json
Cookie: vantage_session=…

{ "symbol": "AAPL", "side": "BUY", "type": "MARKET", "qty": "10", "referencePrice": "190.00" }
```

- `symbol`: ticker, case-insensitive. `side`: `BUY` or `SELL`. `type`: `MARKET`.
- `qty`: a positive whole number, as a JSON integer or a digit string, at most **1,000,000** shares (`MAX_ORDER_QTY`). Floats, zero, negatives, exponents and leading zeros are rejected.
- `referencePrice`: the price the user saw (the ask for a BUY, the bid for a SELL): a plain decimal string greater than zero, at most 12 integer and 8 decimal digits. A JSON number is rejected. It feeds the 1% price collar (`PRICE_MOVED`).
- The server decides the account, the instrument, the quote and its freshness, the fee schedule, the kill switch and the time (D-59).

Response `201`:

```json
{
  "id": "0198d0d0-…",
  "symbol": "AAPL",
  "side": "BUY",
  "type": "MARKET",
  "status": "FILLED",
  "qty": "10",
  "filledQty": "10",
  "rejectCode": null,
  "createdAt": "2026-11-10T15:00:00.000Z",
  "execution": {
    "id": "0198d0d0-…",
    "qty": "10",
    "price": "190.04",
    "notional": "1900.40",
    "fee": "0.00",
    "slippageBps": "2",
    "executedAt": "2026-11-10T15:00:00.000Z",
    "quoteSource": "FIXTURE"
  }
}
```

A rejected order has `status: "REJECTED"`, `filledQty: "0"`, `execution: null` and a `rejectCode`. It is still `201`, it is stored, `GET` returns it, and a replay returns it:

```json
{
  "status": "REJECTED",
  "rejectCode": "INSUFFICIENT_BUYING_POWER",
  "filledQty": "0",
  "execution": null
}
```

### Idempotency (D-58 and its amendment)

- `Idempotency-Key` is **required**: 8 to 128 characters from `A-Z a-z 0-9 . _ : -`, otherwise `400 IDEMPOTENCY_KEY_INVALID`.
- The key is also stored as the order's `client_order_id` (amendment to D-58: the body has no `clientOrderId`).
- Order of checks: look up `(account, key)` first. **Same key and same request** (compared by a SHA-256 of the validated, canonical request, not the raw bytes: `qty` `10` equals `"10"`, price `190` equals `190.00`, key order and symbol case do not matter) returns the **stored response with the same status code and body**; nothing is executed again. **Same key and a different request** is `422 IDEMPOTENCY_MISMATCH` and changes nothing. No row: the order is executed. Stored rows are kept at least 48 hours (the purge job is a later milestone).
- The idempotency row is written in the **same database transaction** as the order, the ledger entries, the execution and the position. If anything fails, nothing is stored and the retry with the same key runs normally.
- Keys are per account, so two users may use the same key without colliding or seeing each other's orders.
- Errors that are not orders (`400`, `404 INSTRUMENT_NOT_FOUND`, `429`, `500`) are not stored, so the same key may be retried.
- `DUPLICATE_CLIENT_ORDER_ID` (`409`) is an **unreachable guard**: the key row and the order are written together under the account lock, so a second order with the same key cannot exist.

### GET /v1/orders

Query: `limit` (1 to 100, default 50), `cursor` (opaque: pass `nextCursor` unchanged), `status` (`FILLED` or `REJECTED`), `symbol`. Response `{ "orders": [OrderResponse…], "nextCursor": "…" | null }`. The cursor is a position `(created_at, id)`, so orders added between two page reads never cause a duplicate or a skip of orders further down the list. A malformed cursor, limit or filter is `400 VALIDATION_ERROR`.

### GET /v1/positions

```json
{ "positions": [{ "symbol": "AAPL", "qty": "10", "avgCost": "190.04" }] }
```

Only positions with a quantity above zero. `avgCost` is the average cost per share of the open lots (fees are not part of cost).

### Business reject codes (`rejectCode`)

First failing rule wins (the order of this list). Details: [trading.md](trading.md).

`TRADING_PAUSED`, `ACCOUNT_NOT_ACTIVE`, `INSTRUMENT_NOT_TRADABLE`, `INSTRUMENT_HALTED`, `QTY_BELOW_MIN`, `QTY_STEP_VIOLATION`, `NO_ELIGIBLE_QUOTE`, `MARKET_CLOSED`, `STALE_QUOTE`, `PRICE_MOVED`, `INSUFFICIENT_BUYING_POWER`, `INSUFFICIENT_POSITION`, `FEE_EXCEEDS_PROCEEDS`.

### Order error codes (HTTP errors)

| HTTP | code                        | When                                                                                                               |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 400  | `VALIDATION_ERROR`          | Body, query or cursor failed validation (names the fields, never the values).                                      |
| 400  | `IDEMPOTENCY_KEY_INVALID`   | `Idempotency-Key` missing or not 8 to 128 characters of `A-Za-z0-9._:-`.                                           |
| 401  | `UNAUTHENTICATED`           | No or invalid session.                                                                                             |
| 403  | `CSRF_REJECTED`             | `Origin` (or `Referer`) is not `WEB_ORIGIN`.                                                                       |
| 404  | `INSTRUMENT_NOT_FOUND`      | Unknown symbol on `POST /v1/orders`.                                                                               |
| 404  | `ORDER_NOT_FOUND`           | Unknown, malformed or another user's order id.                                                                     |
| 404  | `ACCOUNT_NOT_FOUND`         | The user has no MAIN account.                                                                                      |
| 409  | `DUPLICATE_CLIENT_ORDER_ID` | Unreachable guard (see above).                                                                                     |
| 422  | `IDEMPOTENCY_MISMATCH`      | Same `Idempotency-Key`, different request.                                                                         |
| 429  | `RATE_LIMITED`              | More than `ORDER_RATE_LIMIT_PER_MINUTE` (default **30**) order requests per user per minute; `Retry-After` header. |
| 500  | `INTERNAL_ERROR`            | Unexpected failure: the transaction is rolled back, the body has only a request id.                                |

### Rate limit, audit and the kill switch

- `POST /v1/orders` is limited **per user** (not per IP): 30 per minute by default (`ORDER_RATE_LIMIT_PER_MINUTE`). It reuses the M2 in-memory limiter: counters live in one process (several API processes each count separately; a restart clears them). Every authenticated request counts, replays included. Anonymous requests get 401 first and never touch a user's allowance.
- Every first placement writes an `audit_logs` row `ORDER_PLACED` (actor, order id, outcome and reject code, request id, IP). Request bodies, cookies and keys are never logged. If the audit insert fails it is logged and swallowed (the order stands), as for the M2 audit events.
- `TRADING_ENABLED` (config; default `true` for local and test, **must be set explicitly** in staging and production): when `false` every new order is stored as `REJECTED` with `TRADING_PAUSED`.
- Delayed quotes are executable (`allow_execution_on_delayed` is true in the MVP, TRADING_ENGINE section 3, D-09); `STALE`, `CLOSED` and `UNAVAILABLE` are not.

## Portfolio, history and activity (M5, read side)

All routes need a valid session and answer for the session user's own MAIN account only: **there is no account id in any URL, query or body**, and another user's rows are never reachable. They are read-only (no ledger write; the only table the job writes is `equity_snapshots`). Money amounts are decimal strings **rounded to 2 decimals, HALF_EVEN, only at the API edge**; every object with rounded amounts has an `exact` companion with the full-precision values. Prices (`avgCost`, `mark`, `price`) are canonical and never rounded. Definitions and honesty rules: [portfolio.md](portfolio.md).

| Method and path                     | Success                          | Notes                                                                                         |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /v1/portfolio`                 | `200` `PortfolioResponse`        | Cash, positions valued at the bid with freshness labels, realised and unrealised P&L, equity. |
| `GET /v1/portfolio/history?from&to` | `200 { snapshots }`              | Daily equity snapshots, oldest first, **at most 366 rows**.                                   |
| `GET /v1/executions`                | `200 { executions, nextCursor }` | Newest first, cursor pagination, optional `symbol` filter.                                    |
| `GET /v1/ledger/activity`           | `200 { activity, nextCursor }`   | The user's own ledger transactions in plain language, newest first, cursor pagination.        |

### GET /v1/portfolio

One consistent read: cash, the ledger totals, positions and lot cost bases come from a single `REPEATABLE READ`, read-only transaction (D-63), so cash and lots never disagree inside one answer. Marks are then taken from the quote store with the shared freshness function.

```json
{
  "currency": "USD",
  "cash": "8099.60",
  "positionsValue": "1950.00",
  "costBasis": "1900.40",
  "unrealisedPnl": "49.60",
  "realisedPnl": "0.00",
  "fees": "0.00",
  "equity": "10049.60",
  "initialCapital": "10000.00",
  "totalReturn": "49.60",
  "incomplete": false,
  "unvaluedCount": 0,
  "positions": [
    {
      "symbol": "AAPL",
      "qty": "10",
      "avgCost": "190.04",
      "costBasis": "1900.40",
      "valuation": "VALUED",
      "unavailableReason": null,
      "mark": "195.00",
      "markBasis": "BID",
      "marketValue": "1950.00",
      "unrealisedPnl": "49.60",
      "quote": { "freshness": "DELAYED", "asOf": "2026-11-10T14:45:00.000Z", "source": "FIXTURE" },
      "exact": { "costBasis": "1900.40", "marketValue": "1950.00", "unrealisedPnl": "49.60" }
    }
  ],
  "asOf": "2026-11-10T14:45:00.000Z",
  "generatedAt": "2026-11-10T15:00:00.000Z",
  "exact": { "cash": "8099.60", "equity": "10049.60", "totalReturn": "49.60" }
}
```

(`exact` repeats every total at full precision; shortened here.)

- `mark` is the **bid** (`markBasis: "BID"`); only when there is no positive bid is the last price used (`"LAST"`). The ask is never a mark.
- `quote.freshness` is `REAL_TIME`, `DELAYED`, `STALE`, `CLOSED` or `UNAVAILABLE`, from the shared market-model function. A STALE quote is still valued but labelled `STALE`; a CLOSED market uses the last bid, labelled `CLOSED`, with `quote.asOf` shown.
- **No usable quote:** `valuation: "UNAVAILABLE"` with `unavailableReason` (`NO_QUOTE` or `NO_USABLE_PRICE`), and `mark`, `marketValue` and `unrealisedPnl` are `null`. The position is **excluded** from `positionsValue`, `unrealisedPnl`, `equity`, and the response says so: `incomplete: true`, `unvaluedCount`, and `totalReturn: null`. It is never valued at zero and never silently at cost. `costBasis` (total) still includes it, so the books reconcile.
- `equity = cash + positionsValue` (valued positions only). `totalReturn = equity - initialCapital`, only when every position is valued.
- `realisedPnl` = minus the `REALIZED_PNL` ledger balance (equals the sum of the lot closures' trading P&L, gross of fees); `fees` = the `FEES` ledger balance. The identity `cash + costBasis + fees - realisedPnl = initialCapital` holds at every read.
- `asOf` is the oldest quote timestamp used for a valuation (`null` when nothing was valued); `generatedAt` is server time.
- Day change is not reported (it needs prior-close data, M3b).

### GET /v1/portfolio/history

Query `from` and `to` (`YYYY-MM-DD`, inclusive, real dates, `from` not after `to`, at most 366 days apart; defaults: `to` = today UTC, `from` = `to` minus 365 days). Response:

```json
{
  "snapshots": [
    {
      "date": "2026-11-10",
      "cash": "8099.60",
      "positionsValue": "1950.00",
      "equity": "10049.60",
      "valuedComplete": true,
      "quoteAsOf": "2026-11-10T20:45:00.000Z",
      "exact": { "cash": "8099.60", "positionsValue": "1950.00", "equity": "10049.60" }
    }
  ]
}
```

`valuedComplete: false` means at least one position could not be valued that day; `positionsValue` and `equity` then exclude it (same rule as the portfolio). Snapshots are written by the in-process job after each NYSE close (see portfolio.md).

### GET /v1/executions

Query: `limit` (1 to 100, default 50), `cursor` (opaque, from `nextCursor`), `symbol`. Newest first by `(executedAt, id)`.

```json
{
  "executions": [
    {
      "id": "0198d0d0-…",
      "orderId": "0198d0d0-…",
      "symbol": "AAPL",
      "side": "SELL",
      "qty": "6",
      "price": "194.96",
      "notional": "1169.76",
      "fee": "0.00",
      "slippageBps": "2",
      "executedAt": "2026-11-10T15:00:00.000Z",
      "quote": {
        "bid": "195.00",
        "ask": "195.05",
        "last": null,
        "asOf": "2026-11-10T14:45:00.000Z",
        "source": "FIXTURE",
        "entitlement": "DELAYED"
      },
      "realisedPnl": "29.52",
      "exact": { "notional": "1169.76", "fee": "0.00", "realisedPnl": "29.52" }
    }
  ],
  "nextCursor": null
}
```

`realisedPnl` is, for a SELL, the trading P&L of the lots it closed (gross of fees, from `lot_closures`); for a BUY it is `null`.

### GET /v1/ledger/activity

Query: `limit`, `cursor`. Each item is one ledger transaction of the caller's account:

```json
{
  "activity": [
    {
      "id": "0198d0d0-…",
      "kind": "FILL",
      "title": "Trade",
      "description": "SELL 6 AAPL @ 194.96",
      "createdAt": "2026-11-10T15:00:00.123Z",
      "cashEffect": "1169.76",
      "orderId": "0198d0d0-…",
      "exact": { "cashEffect": "1169.76" }
    }
  ],
  "nextCursor": null
}
```

`kind` is one of `GRANT`, `COMPETITION_GRANT`, `FILL`, `FEE`, `ORDER_RESERVE`, `ORDER_RELEASE`, `CORPORATE_ACTION`, `ADJUSTMENT`; `title` is the plain-language label ("Starting capital", "Trade", ...); `cashEffect` is the signed change of the cash balance (negative when cash went out); `orderId` links a trade to its order. **No ledger account ids, entry ids or other accounts' data are returned**; only the transaction's own id.

### Pagination and errors

Cursors are positions `(timestamp, id)` inside the caller's own result set: rows inserted between two page reads never cause a duplicate or a skip of rows further down the list, and a cursor from another user only ever shows the reader's own older rows. Errors use the standard envelope:

| HTTP | code                | When                                                                                             |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------ |
| 400  | `VALIDATION_ERROR`  | Bad `limit`, `cursor`, `symbol`, date or range; unknown query parameter (such as an account id). |
| 401  | `UNAUTHENTICATED`   | No or invalid session.                                                                           |
| 404  | `ACCOUNT_NOT_FOUND` | The user has no MAIN account.                                                                    |
| 500  | `INTERNAL_ERROR`    | Unexpected failure (request id only; nothing is written by these routes).                        |
