# Durable jobs and artifacts

Apply `supabase/migrations/202610120001_makeready.sql` only to the dedicated MakeReady Supabase project. It expects Supabase's `anon`, `authenticated`, `service_role` roles and `storage.buckets`. Tables have RLS enabled and no browser policies; only the server service role can read or write them. All public RPCs are `SECURITY DEFINER` with an empty `search_path`, explicitly qualified application tables and restricted execute grants.

## RPC contract

Existing argument names and order are unchanged:

| RPC | Result | Guarantee |
| --- | --- | --- |
| `mr_create_job(scope, job, payload, key, input_hash, reserve_micros, cap_micros)` | Public job JSON | Scope budget row locks serialize deduplication, reservation and the two accepted execution jobs per plan. Reusing a key for another request/session/lineage raises `IDEMPOTENCY_CONFLICT`. |
| `mr_claim_job(id, owner)` | Full job row with `fence`, or `null` | Only one live lease. Terminal jobs cannot be reclaimed. Lease duration is six minutes, longer than the bounded 300 second executor request. |
| `mr_patch_job(id, fence, patch, payload = null, provider_ref = null)` | Public job JSON | Requires an active, unexpired lease and exact fence. Identity and terminal results cannot be patched. A saved provider receipt cannot be replaced. |
| `mr_release_job(id, fence)` | Void | Clears the matching lease and increments its fence, immediately preventing that worker from writing again. |
| `mr_finish_job(id, fence, record, kind)` | Stored revision or plan | Atomically validates, appends one primary result, completes the job, settles its reservation and appends a completion event. Exact replay returns the stored result; changed replay raises `FINALIZATION_CONFLICT`. |
| `mr_fail_job(id, fence, error, unknown = false)` | Void | Known termination conservatively counts the reservation as spent once. Unknown paid submission retains its reservation and prevents automatic retry. |

Supabase parameter names retain the `p_` prefix; the table above abbreviates them for readability. A lease is valid only when its owner and expiry are present, expiry is in the future, and the fence matches. Release, finalization, failure and interrupted-dispatch quarantine invalidate the old fence. No browser heartbeat is needed. Reconciliation/webhook execution must be configured by the deployment; storing a job alone does not schedule its completion.

The first accepted request establishes a scope's budget cap. Subsequent calls cannot increase that cap. A scope budget is an estimate ledger, not a provider billing statement. Failed known requests count as spent conservatively; unknown submissions remain reserved until explicit operator reconciliation. Two accepted jobs per plan includes failures and unknown submissions; repeating the same idempotency key does not consume another attempt.

## Artifact and lineage invariants

- Storage receipts contain immutable session, object path, SHA-256, byte length, MIME type, units and up axis. Signed URLs and expiry fields are response-only and rejected in persisted receipts.
- Server storage code uploads without overwrite, downloads the stored object, verifies its complete bytes against SHA-256 and length, then records `verified = true`. An uploaded image starts unverified and can become verified after the same download check. Even an unverified receipt's metadata cannot be changed.
- Revision finalization requires exact JSON equality with each verified receipt in the same session, not only matching hash and size. Paths follow `session/id/sha256.extension`. Duplicate artifact IDs are rejected.
- A concept needs a stored source or concept image. A manufacturing revision needs `source_glb`, `model_glb` (metres/Y-up), `model_stl` (millimetres/Z-up), and `audit`. Failed physical checks are valid report contents and do not prevent artifact persistence. They do not become a manufacturing approval.
- Original GLB receipts may be reused from the parent when scaling. The new normalized GLB/STL/audit are separate artifacts. Parent records and all finalized artifacts remain immutable.
- Plans and revisions must reference a parent in the same session. Job lineage must match finalized record lineage. Decisions and evaluations refer to an exact revision and its complete artifact hash multiset. Comparisons validate parent/child lineage, optional plan ownership, and evaluation kind/revision references.
- Events and design records are append-only. A job has one primary plan/revision result. Physical and visual evaluations may coexist for the same source job.

The SQL engine cannot read Supabase Storage objects. `verified` is a trusted server receipt for the successful upload/download verification, not proof that an object will remain readable forever. Every subsequent `readArtifact` downloads and rechecks hash and length; unavailable or corrupted files must be reported as errors. The service key remains a trusted boundary and must never reach the browser. Deploying this migration does not prove live Storage, provider, webhook, cron or browser behavior.

## Executed SQL validation

`tests/persistence/migration.test.ts` runs the **complete migration and its PL/pgSQL functions on PostgreSQL via PGlite**. It creates an isolated in-memory database, minimal Supabase roles/bucket metadata, and synthetic verification receipts. It never uses project credentials or contacts an existing database.

The test engine is a development dependency. Run it through the normal test command:

```sh
pnpm exec vitest run tests/persistence/migration.test.ts
```

The engine was actually executed during development on PGlite 0.5.8 / PostgreSQL 18.3, initially installed in an isolated temporary directory and then added as a reproducible project development dependency. Tests cover migration syntax, real role permissions, idempotency and budget rollback, exclusive sequential leases, stale/expired/released fencing, interrupted dispatch quarantine, once-only settlement, exact artifact validation, cross-session lineage, immutable parents, scale source reuse, two revision attempts, decisions, independent evaluation records and comparison references.

PGlite serializes queries and transactions on one connection. These tests verify PostgreSQL execution and transactional rollback, **not a multi-connection race**. Before claiming that stronger guarantee, run the same migration against an isolated native PostgreSQL/Supabase database with two independent clients racing `mr_create_job`, `mr_claim_job` and `mr_finish_job`. The migration uses PostgreSQL row locks and unique indexes for those cases; native concurrent-client and live deployment proof remain separate checks.

References: [PGlite execution API](https://pglite.dev/docs/api), [PostgreSQL expression indexes](https://www.postgresql.org/docs/17/sql-createindex.html), [row locks](https://www.postgresql.org/docs/17/sql-select.html), and [safe SECURITY DEFINER configuration](https://www.postgresql.org/docs/17/sql-createfunction.html).
