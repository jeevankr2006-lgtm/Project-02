# SynapseGate v2: Self-Healing Incident Triage Gateway

DecodeLabs Full Stack Development, **Project 2: Backend API Development**.

A backend REST API with a built-in web dashboard. Support incidents enter through one **gateway**,
pass a **gatekeeper** that validates them, are scored by a **triage engine** (priority + SLA deadline),
and are stored with comments, an assignee and a full audit history. High and critical tickets trigger a notifier
protected by a **circuit breaker**, so a failing dependency never takes the API down. The API documents itself,
reports its own vital signs, and can test itself.

- **Zero dependencies.** Only Node's built-in modules. **No `npm install` needed.**
- **Node 18 or newer** (built and tested on Node 22).
- **60 automated tests**, plus a browser-tested dashboard and a one-click **API self-check**.

---

## Run it in VS Code (3 steps)

1. **Install Node.js** (LTS) from nodejs.org. Check with `node -v` in a terminal (should print v18 or higher).
2. In VS Code: **File > Open Folder** and choose the `synapsegate` folder (the one containing `package.json`).
   Accept the popup to install the recommended extension **REST Client**.
3. Open the terminal (**Ctrl + `**) and run:

```bash
npm start
```

Then open **http://localhost:3000/** in your browser. That is the dashboard: create tickets, assign, comment,
change status, override priority, break the notifier and watch the circuit open, all with buttons.

You can also press **F5** in VS Code to start the server (there is a ready-made launch configuration).

| What you want | How |
|---|---|
| Use the app | Open `http://localhost:3000/` |
| Call the API from VS Code | Open `requests.http` and click **Send Request** above any request (REST Client extension) |
| Check that every API works | Click **Run self-check** on the dashboard, or run `npm run check` in a second terminal |
| Run the tests | `npm test` (60 tests) |
| Guided demo in the terminal | `npm run demo` (server must be running) |
| Auto-restart while editing | `npm run dev` |
| Use another port | PowerShell: `$env:PORT=4000; npm start`  |  Mac/Linux: `PORT=4000 npm start` |

### If something is not working

| Symptom | Cause and fix |
|---|---|
| Opening `/api/v1/tickets` in the browser shows `401 UNAUTHORIZED` | **This is correct.** Browsers cannot send the `x-api-key` header. Use the dashboard at `/`, or `requests.http`, or Thunder Client / Postman with header `x-api-key: agent-key-123`. Only `/health`, `/docs` and `/api/v1/` work without a key. |
| `'npm' is not recognized` or `node: command not found` | Node.js is not installed, or restart VS Code after installing it. |
| `Port 3000 is already in use` | An old server is still running. Press Ctrl+C in its terminal, or use another port (see the table above). |
| `SynapseGate needs Node.js 18 or newer` | Install the current LTS version from nodejs.org. |
| `npm run check` says it cannot reach the server | Start the server first (`npm start`) in another terminal. |
| `npm run check` fails every step with 401 | The server was started with different keys. Set `VIEWER_KEY`, `AGENT_KEY`, `ADMIN_KEY` to the same values for the check. |
| PowerShell and `curl` | In PowerShell `curl` is a different command. Use `curl.exe`, or just use the dashboard / `requests.http`. |
| Want to start with empty data | Stop the server and delete `data/tickets.json` (and `data/idempotency.json`). |

If a request fails, the response always contains an error `code`, a `message`, `details` (for validation) and a `requestId`.

---

## Demo API keys

Sent in the `x-api-key` header. Change them with the `VIEWER_KEY`, `AGENT_KEY`, `ADMIN_KEY` environment variables.

| Role   | Key              | Can do                                                          |
|--------|------------------|-----------------------------------------------------------------|
| viewer | `viewer-key-123` | GET endpoints only                                              |
| agent  | `agent-key-123`  | viewer + create tickets, comment, assign, change status         |
| admin  | `admin-key-123`  | everything: DELETE, priority override, metrics, simulator, logs |

## Endpoints (all under `/api/v1`)

| Method | Route                   | Purpose                                                    | Role         | OK  |
|--------|-------------------------|------------------------------------------------------------|--------------|-----|
| GET    | `/`                     | API index with links                                       | public       | 200 |
| GET    | `/health`               | Pulse + data-store integrity check                         | public       | 200 |
| GET    | `/docs`                 | Self-generated documentation with curl examples            | public       | 200 |
| POST   | `/tickets`              | Create a ticket (optional `Idempotency-Key` header)        | agent, admin | 201 |
| GET    | `/tickets`              | List: filter, search, sort, paginate                       | all roles    | 200 |
| GET    | `/tickets/{id}`         | One ticket                                                 | all roles    | 200 |
| PUT    | `/tickets/{id}/status`  | Move status forward (open, in_progress, resolved)          | agent, admin | 200 |
| PUT    | `/tickets/{id}/assignee`| Assign a person, or `null` to unassign (idempotent)        | agent, admin | 200 |
| PUT    | `/tickets/{id}/priority`| Override the triage priority with a reason                 | admin        | 200 |
| POST   | `/tickets/{id}/comments`| Add a comment                                              | agent, admin | 201 |
| GET    | `/tickets/{id}/comments`| List comments                                              | all roles    | 200 |
| GET    | `/tickets/{id}/history` | Audit trail                                                | all roles    | 200 |
| DELETE | `/tickets/{id}`         | Remove a ticket with its comments and history              | admin        | 204 |
| GET    | `/stats`                | Counts by priority, status, category, overdue SLAs         | all roles    | 200 |
| GET    | `/metrics`              | Latency, throughput, availability, errors                  | admin        | 200 |
| GET    | `/admin/notifier`       | Notifier mode, circuit state, queue, counters              | admin        | 200 |
| PUT    | `/admin/notifier`       | Failure simulator: `{"mode":"healthy"}` or `{"mode":"failing"}` | admin   | 200 |
| GET    | `/admin/logs`           | Recent API requests (newest first)                         | admin        | 200 |

Every endpoint can also return 429 (rate limit) and 500 (unexpected error). The full per-endpoint list of error codes is in `GET /docs`.

### `GET /tickets` query parameters

| Parameter | Meaning |
|---|---|
| `page`, `limit` | Pagination (limit 1-50, default 10) |
| `priority`, `status`, `category` | Exact filters |
| `assignee` | A name (case-insensitive) or `unassigned` |
| `search` | Text in title or description (case-insensitive) |
| `overdue` | `true`: unresolved tickets past their SLA. `false`: everything else |
| `createdFrom`, `createdTo` | ISO dates such as `2026-10-10` or `2026-10-10T09:30:00Z`. A date-only `createdTo` includes the whole day (UTC) |
| `sort` | `score`, `-score`, `createdAt`, `-createdAt` (default), `slaDueAt`, `-slaDueAt` |

Unknown or repeated parameters return 400.

### Response format

```jsonc
// success
{ "data": { ... }, "meta": { "requestId": "req_8f3a21" } }      // lists add page, limit, total, totalPages
// error
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": ["..."] }, "requestId": "req_8f3a22" }
```

Every response carries `X-Request-Id` and `X-Response-Time`. Error codes:
`VALIDATION_FAILED`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `DUPLICATE_TICKET`, `IDEMPOTENCY_KEY_REUSED`,
`INVALID_STATUS_TRANSITION`, `NO_CHANGE`, `TICKET_RESOLVED`, `UNAUTHORIZED`, `FORBIDDEN`, `TICKET_NOT_FOUND`,
`ROUTE_NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`.

---

## How it works

### Request pipeline (IPO model)

| # | Step        | Stage   | What happens                                                                 | Failure          |
|---|-------------|---------|------------------------------------------------------------------------------|------------------|
| 1 | Request ID  | Input   | Unique ID generated (a safe client `X-Request-Id` is reused)                 | n/a              |
| 2 | Rate limit  | Input   | 100 requests/minute per API key (per IP for unknown callers)                 | 429 + Retry-After |
| 3 | AuthN       | Input   | `x-api-key` identifies the caller                                            | 401              |
| 4 | AuthZ       | Input   | Role must be allowed on the route                                            | 403              |
| 5 | Gatekeeper  | Input   | Body size and JSON syntax, then syntactic + semantic validation              | 400 + details    |
| 6 | Idempotency | Process | Replay the stored result if the same `Idempotency-Key` was already used      | 400 if reused with another body |
| 7 | Duplicate check, triage | Process | Reject an identical open ticket; compute score, priority, SLA | 400 / 500 (caught) |
| 8 | Persist     | Process | Save ticket and first history entry to the JSON store                        | 500 (caught)     |
| 9 | Notify      | Process | High/critical only: notifier called through the circuit breaker              | ticket still saved |
| 10 | Respond    | Output  | JSON envelope with the correct status code                                   | n/a              |
| 11 | Record     | Output  | Method, status and latency written to metrics and the activity feed          | n/a              |

### Triage engine

`score = category points + keyword points + audience points` (capped at 100; the real maximum is 95).

| Rule | Points |
|------|--------|
| Category: security 45, outage 40, billing 20, bug 15, general 5 | 5 to 45 |
| Keywords (whole words) in title/description: `urgent`, `down`, `breach`, `cannot login`, `payment failed`: +15 each | max +30 |
| `affectedUsers`: 100 or more = +20, 10 to 99 = +10, below 10 = 0 | 0 to 20 |

| Score | Priority | SLA (`slaDueAt`) | Notifier called |
|-------|----------|------------------|-----------------|
| 0-29  | low      | +72 hours        | no  |
| 30-59 | medium   | +24 hours        | no  |
| 60-79 | high     | +4 hours         | yes |
| 80-100| critical | +1 hour          | yes |

Example: outage (40) + "down" (15) + "urgent" (15) + 150 users (20) = **90**, critical, due in 1 hour.
Every ticket includes a `scoreBreakdown`. An admin can override the priority (`PUT /tickets/{id}/priority`):
the score stays as computed, `priorityOverridden` becomes `true`, and the **SLA clock restarts from the moment of the override**.
An override does not call the notifier.

### Gatekeeper (validation)

- **Syntactic:** valid JSON under 10 KB; no unknown fields; email format; title 5-100 characters; description 10-1000;
  category in `security, outage, billing, bug, general`; `affectedUsers` an integer 1-100000; comment text 1-500;
  assignee 2-50 characters; override reason 5-200; HTML tags stripped from all text; query values valid.
- **Semantic:** description must not repeat the title; security tickets require `affectedUsers`; status only moves forward
  (`open -> in_progress -> resolved`, no reopening, but `open` may jump straight to `resolved`); a resolved ticket cannot get a priority override;
  the same email cannot open an identical unresolved ticket (same category and title) less than 10 minutes after the first.

### Circuit breaker (notifier)

| State     | Behaviour                                                                | Moves to |
|-----------|--------------------------------------------------------------------------|----------|
| CLOSED    | Notifier is called (simulated 300 ms). Consecutive failures are counted. | OPEN after 3 consecutive failures |
| OPEN      | No call is made (fail fast). Tickets are still created; notification is `queued`. | HALF_OPEN after 20 seconds |
| HALF_OPEN | One trial call is allowed.                                               | CLOSED on success (queue flushes), OPEN on failure |

Try it on the dashboard (Admin role): click **Make notifier fail**, create three critical tickets (use **Fill example**, change the title each time), then a fourth.
The fourth answers instantly because the circuit opened. Click **Make notifier healthy**, wait 20 seconds, create another critical ticket:
the breaker closes and the queued notifications are delivered.

### Idempotency

POST is unsafe and non-idempotent. Send an `Idempotency-Key` header (1-64 characters: letters, digits, `-`, `_`) and a
retried request returns the **original** 201 response with `Idempotent-Replayed: true` instead of creating a second ticket.
Keys are scoped to the API key, stored for 24 hours, and two simultaneous requests with the same key create exactly one ticket.
The dashboard sends a fresh key with every create, so a double click cannot create two tickets.

---

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | 3000 | Listen port |
| `DATA_DIR` | `./data` | Where `tickets.json` and `idempotency.json` are saved |
| `PERSIST` | `true` | `false` keeps everything in memory only |
| `LOG_REQUESTS` | `true` | One JSON log line per request in the terminal |
| `CORS` | `true` | Allow other origins (for example a frontend on another port) |
| `VIEWER_KEY`, `AGENT_KEY`, `ADMIN_KEY` | demo keys above | API keys |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | 100, 60000 | Rate limit |
| `BREAKER_RESET_MS` | 20000 | OPEN to HALF_OPEN delay |
| `NOTIFIER_LATENCY_MS` | 300 | Simulated notifier call time |

## Tests

`npm test` runs 60 tests: unit tests (triage, circuit breaker) and API tests against a real server on a random port.

- `tests/api.test.js`: the 15 acceptance tests from the project spec plus edge cases (validation, auth, idempotency, rate limit, breaker, metrics, docs, persistence, the 500 handler, CORS).
- `tests/features.test.js`: comments, assignee, priority override, search/overdue/date filters, admin notifier and logs, the dashboard files, persistence of the new data, and the shared self-check.
- `tests/triage.test.js`, `tests/breaker.test.js`: unit tests.

The dashboard itself was tested in a real headless browser (create, validate, assign, comment, status, override, simulator, role switch,
self-check, and an HTML-injection attempt that must not execute).

## Project structure

```
synapsegate/
  server.js                      start the app (friendly errors), graceful shutdown
  requests.http                  one-click API requests for the VS Code REST Client extension
  public/                        the dashboard: index.html, dashboard.js, style.css, selfcheck.js
  src/
    app.js                       the gateway pipeline + dashboard file serving
    routes.js                    route registry (feeds routing AND /docs)
    router.js  config.js  errors.js  http.js  util.js
    gateway/                     requestId, rateLimit, auth, metrics, errorHandler
    modules/
      tickets/                   handlers, validator (Gatekeeper), triage, store, idempotency
      notifier/                  notifier, circuitBreaker
      ops/                       health, metrics, failure simulator, logs
      docs/                      docs generator
  tests/                         unit + API tests
  scripts/                       check.js (self-check), demo.js, generate-postman.js
  postman/                       generated Postman collection (npm run postman)
  .vscode/                       F5 launch, tasks, recommended extensions
  data/                          JSON store (created at runtime)
```

Postman: import `postman/SynapseGate.postman_collection.json`. Variables (`baseUrl`, keys) are preset to the demo values.

## Design decisions and limits (read before you present it)

- **Status moves forward only.** `open` may jump straight to `resolved`; going back or repeating a status returns 400.
- **Duplicate check runs after the idempotency lookup**, so a safe retry is replayed instead of being rejected as a duplicate.
- **`notification: "pending"`** exists for a moment while the notifier is being called; clients normally see `sent`, `queued` or `not_required`.
- **Availability** = share of requests that did not end in a 5xx response. Latency figures use the last 1000 requests.
- **The activity feed** (`/admin/logs`) keeps the last 100 requests and leaves out polling calls to `/health` and `/admin/logs`.
- **Statelessness:** no sessions; each request carries its key. Tickets, comments, history and idempotency records are saved to JSON files, so a restart keeps them.
  Rate-limit counters, breaker state, the notification queue and the activity feed are in memory and reset on restart.
- **Storage is a JSON file**, chosen because the project is about mastering endpoints before databases. It is not meant for production load.
- **Demo API keys are public.** The dashboard keeps keys in your browser's localStorage. Set your own keys with environment variables for anything beyond local use.
- The notifier is a **simulation** (no real email or webhook is sent).
- Scoring points, SLA hours, 100 requests/minute, 3 failures / 20 seconds and the 10-minute duplicate window are design choices, not requirements, and are easy to change.
