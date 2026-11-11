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
