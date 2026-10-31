# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Implemented Contract

Send one `Idempotency-Key` for each logical incident and reuse that key for retries.
Keys must be non-blank and at most 255 characters. Invalid keys or incident
payloads return `400` before any writes. The exercise authentication middleware
supplies `req.user.tenantId`; the handler never takes its tenant scope from the
request body. In a real deployment, replace the exercise header-based middleware
with verified authentication.

The database primary key is `(tenant_id, operation, key)`, with the fixed operation
`POST:/incidents`. An insert claims ownership before creating an incident. A
concurrent insert waits on PostgreSQL's unique constraint until the owner commits
or rolls back. On commit, duplicates replay the stored `201` status and JSON body,
with `Idempotent-Replayed: true`. Application-level lookup followed by insert
would leave a race in which two processes could both create an incident.

The request hash is SHA-256 over canonical JSON: object keys are sorted
recursively, array order is preserved, and JSON scalar values retain their
types. Reordering object properties is harmless; changing a value, array order,
or the set of properties changes the hash. An unexpired key bound to a different
request returns `409 idempotency_key_conflict`. A matching record still marked
`processing` returns `409 operation_in_progress`; a matching `failed` record
returns `409 prior_operation_failed`. Neither state automatically executes the
request again because the previous outcome may need investigation.

Keys expire 24 hours after the successful claim. An expired row can be reclaimed
atomically by the next request, including a new request body. Expiry ends the
deduplication guarantee: retrying after 24 hours may create another incident.
Clients must not interpret expiry as proof that the original operation failed.
The expiry index also supports later retention cleanup; no background cleanup
worker is required for reclaiming a key.

The key claim, incident, one durable paging job, and stored response commit in a
single transaction. If any step fails, all local writes roll back and a retry
can claim the key again. No external queue or paging provider is called within
the transaction. A worker can deliver committed jobs later, using the stable
job ID for provider-side deduplication: this database guarantee does not make
external delivery exactly once by itself.

Stored responses contain incident titles and identifiers, so treat the replay
table as tenant data, restrict access, and include it in retention and deletion
policies. This endpoint stores only its small incident response, never arbitrary
request headers or credentials. Larger endpoints should bound replay-response
size and avoid caching sensitive fields unnecessarily.

## Validation

The 14 supplied tests pass unchanged with Node.js 26 and PostgreSQL 16. They
include 20 concurrent duplicates and verify one incident and one paging job.
Additional local checks passed for concurrent expiry reclamation, concurrent
requests with conflicting payloads, and a forced paging-job failure that rolls
back every local write before a successful retry.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
