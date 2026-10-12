# Genuine photo-to-package run

`scripts/generate-live.mts` uses the existing typed HTTP client and real application routes. It uploads the supplied original image, verifies the server receipt, waits for the stored concept, approves its exact artifact hashes, starts one fal model job, waits for completion and downloads the actual manufacturing package. It never uses demo fixtures or creates substitute model files.

## Prerequisites

- The dedicated MakeReady database migration and private Storage bucket are configured on the running app.
- The app has `FAL_KEY` and working job reconciliation/webhook execution. Polling only reads existing jobs; it does not execute them. A stored photo concept and human approval need no LLM billing. Optional feedback requires working configured design intelligence and image editing.
- The runner process has `APP_URL` (app origin, HTTPS except localhost) and `DEMO_PASSWORD`. Keep them in the local environment or an ignored environment file; never pass the password as a command argument.
- Supply your actual PNG/JPEG/WebP reference, at most 10 MiB. Choose a subject you are authorized to process.

## Run

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --image /absolute/path/reference.png \
  --height-mm 120 \
  --confirm-cost
```

Use an environment file containing the intended live `APP_URL`; the app's local development URL and deployment URL are separate targets. Without `--confirm-cost`, the script makes **no HTTP requests**. The flag authorizes the explicit paid model submission and, when requested, real planning/refinement calls. Server budget reservations are estimates, not a provider billing statement.

Optional real feedback before approval/model generation:

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --image /absolute/path/reference.png \
  --feedback "Kulakları küçült, yüz ifadesini ve kıyafetleri koru." \
  --confirm-cost
```

Feedback rejects the first stored concept, saves one actual AI revision plan, executes that exact plan once, preserves its parent and approves the resulting concept. The runner does not invent a heuristic revision plan or automatically retry paid work. This is a scripted demo approval; inspect the actual outputs before using them for physical production.

## Evidence and limits

Results default to `artifacts/live/<run-id>/`; `--output /absolute/path/results` chooses another folder. `run.json` records safe IDs and idempotency keys as stages complete. On success, `result.json` records the verified outer ZIP hash, hashes/lengths of its original GLB, normalized GLB and STL, separate physical checks, visual evaluation metadata and the approved revision/decision IDs. The runner also saves the genuine ZIP, its three geometry files and audit. Signed URLs, cookies, passwords, provider credentials, prompts and provider error bodies are not logged or saved.

The existing client verifies upload bytes and downloaded ZIP SHA-256/length. The runner additionally verifies ZIP CRCs, geometry file hashes/lengths against persisted artifact receipts, and the packaged audit's source/output hashes against those exact files. It keeps `fail` and `not_checked` physical results visible. A downloadable package is preparation evidence, not manufacturing certification. Wall thickness, self-intersections, supports and material strength remain unavailable unless actually implemented and checked.

Default waiting is at most 180 job reads separated by five seconds; individual HTTP requests have a 150 second timeout. `--max-polls` and `--poll-ms` adjust the bounded wait. On timeout, API error or `submission_unknown`, the runner stops. Existing server jobs may continue. Inspect the saved IDs in the app and reconcile the saved idempotency keys before any new paid submission. Re-running this command creates a new run; it is not a resume command.

The runner's `--help`, typecheck and lint can be verified without a live deployment. A successful local check does not prove provider generation, database configuration or deployment behavior; retain a genuine `result.json` and files from the live run as that evidence.
