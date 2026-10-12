# MakeReady frontend contract v1.0.0

Source of truth: `@/lib/contracts`. Fixtures: `@/lib/contracts/fixtures` (DEV ONLY; visibly label `FIXTURE_LABEL`). Never show fixtures as generated results. `@/lib/contracts/mcp` defines MCP inputs and typed `structuredContent`.

## Ownership and bootstrap

Claude owns non-API app routes, components, hooks, `components.json`, and `src/lib/utils.ts`. Codex owns backend, typed client, proxy, packages and build scripts. During shadcn init Codex pauses package/lock writes. Tell Codex when init finishes. No React in hand-authored `src/lib`.

## HTTP envelope

All JSON routes return `{data: T}` on success or `{error: {code, message, retryable, details?}}`. Runtime schema exports end with `Schema`; corresponding exported types omit it. IDs are UUIDs, timestamps ISO UTC. Paid requests require `confirmCost: true` and a stable `idempotencyKey` (8–200 chars). Reuse the same key when reconciling an interrupted request; do not invent a new key and silently resubmit.

| Method / route | Input | data |
|---|---|---|
| POST `/api/sessions` | `CreateSessionInput` | `DesignSession` |
| GET `/api/sessions/:id` | — | `DesignSession` complete tree |
| POST `/api/designs/start` | `StartDesignInput` | `StartDesignResult` `{sessionId,job}` |
| POST `/api/revisions/plan` | `PlanRevisionInput` | `RevisionPlan` |
| POST `/api/plans/:id/execute` | `ExecutePlanInput` | `GenerationJob` |
| POST `/api/revisions/:id/decision` | `DecisionInput` | `HumanDecision` |
| POST `/api/revisions/:id/model` | `GenerateModelInput` | `GenerationJob` |
| GET `/api/revisions/:id/package` | — | `MakePackageResult` |
| GET `/api/jobs/:id` | — | `GenerationJob` |
| GET `/api/status?jobId=…` | — | `GenerationJob` alias |
| POST `/api/uploads` | `UploadInput` | `UploadGrant` |
| POST `/api/uploads/complete` | `CompleteUploadInput` | verified `ArtifactRef` |
| POST `/api/access` | `AccessInput` `{password,returnTo?}` | `{redirectTo}` + HttpOnly cookie |

Dynamic path IDs must equal any IDs supplied in the body. Upload original images directly to the signed URL from the grant, then call complete. URL expiry does not mean the stored object expired; reload the session for fresh signed URLs.

## Sessions, jobs and revisions

`getSession(id)` rebuilds the full timeline after reload. Sort records by createdAt then ID. Revisions are materialized immutable snapshots with actual verified artifacts; jobs are separate ongoing/failed records. Evaluations and decisions append; they never modify revision contents. An open but readable mesh may be a completed revision with failed physical checks.

Normal statuses: `created → planning/submitting → queued → running → ingesting → preparing → verifying → completed`. Local/scale operations skip irrelevant stages. `submission_unknown` means paid dispatch may have happened: show uncertainty, preserve the job, never automatically regenerate. `failed` is a terminal confirmed failure. Polling network/429/5xx errors are temporary and do not mean provider failure.

Preparation runs on the SERVER via fal webhook + scheduled reconciliation. NO `awaiting_preparation` and NO browser `resumePreparation`. Polling/getSession never starts paid generation. Closing the browser does not stop the job.

## Refinement and evidence

Call `planRevision()` first. Display `requestedChange`, `interpretedIntent`, `preserve`, `action`, `reason`, `expectedDifferences`. Execute that exact `plan.id` after the user confirms. Up to two automated attempts apply per feedback; new user feedback creates a new plan. Polling is not an attempt.

Visual, physical, human evaluations are separate cards. No combined score. Show every `not_checked` and limitation. Compare genuine parent/child models with identical front, side and three-quarter camera settings, orbit synchronized where possible. Height is normalized in both: bbox/triangle changes do not establish ear size or face preservation. Concept-only comparisons have `geometryDelta: null`.

GLB preserves textures/materials and uses meters/Y-up. STL is geometry only in mm/Z-up. Use `model_glb` in the viewer, not STL. Source GLB is independently preserved; normalized GLB is reserialized. No printability certification.

## Errors the UI must surface

- `ACCESS_REQUIRED`: show Claude-owned `/access` form; invoke `unlock`/POST access, then navigate to returned local redirectTo.
- `CONFIRM_COST_REQUIRED`, `BUDGET_EXCEEDED`: explain confirmation/budget; never retry automatically.
- `SUBMISSION_UNKNOWN`: no duplicate generation; keep the job visible.
- `PROVIDER_UNAVAILABLE`, `PROVIDER_FAILED`: show actual failure and preserved parent.
- `ARTIFACT_UNAVAILABLE`, `INVALID_ARTIFACT`, `UNSUPPORTED_GEOMETRY`, `STORAGE_FAILED`: show missing/unsupported artifact with job ID; never fake success.
- `NOT_READY`: package is not ready; continue polling, not regenerating.
- `CONFLICT`: reused key with different input, stale/unauthorized plan, or missing required approval.

## MCP view boundary

Claude owns `src/components/mcp-view/entry.tsx`, its stylesheet, `App` bridge and presentation. No Next-only imports in shared UI. Register ontoolresult before connecting; consume structuredContent and call tools via app.callServerTool. Do not fetch relative `/api` URLs from the ChatGPT sandbox. Codex bundles entry + Tailwind CSS, generates the hashed HTML resource, and owns CSP. Never put the MCP secret in UI/source/results. Web and MCP share the same session IDs/store.

The React-free typed client and concrete examples will be added without changing these contracts.
