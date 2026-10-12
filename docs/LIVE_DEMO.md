# Genuine photo/text-to-package run

`scripts/generate-live.mts` uses the existing typed HTTP client and real application routes. It uploads the supplied original image, verifies the server receipt, waits for the stored concept, approves its exact artifact hashes, starts one fal model job, waits for completion and downloads the actual manufacturing package. It never uses demo fixtures or creates substitute model files.

Alternatively, `--text --prompt ...` starts a genuine generated concept without an image upload. `--use` records the intended use in the same shared design workflow. Both routes then approve the exact concept and produce the real GLB/STL/audit package. `--image` and `--text` are mutually exclusive; text requires an explicit nonempty prompt.

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

Use an environment file containing the intended live `APP_URL`; the app's local development URL and deployment URL are separate targets. Without `--confirm-cost`, generation mode makes **no HTTP requests**. The separate `--collect-costs` mode only reads billing, as described below. The flag authorizes the explicit paid model submission and, when requested, real planning/refinement calls. Server budget reservations are estimates, not a provider billing statement.

Optional real feedback before approval/model generation:

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --image /absolute/path/reference.png \
  --feedback "Kulakları küçült, yüz ifadesini ve kıyafetleri koru." \
  --confirm-cost
```

Feedback rejects the first stored concept, saves one actual AI revision plan, executes that exact plan once, preserves its parent and approves the resulting concept. The runner does not invent a heuristic revision plan or automatically retry paid work. This is a scripted demo approval; inspect the actual outputs before using them for physical production.

## Text to CNC candidate

Text mode requires the app's working design intelligence and fal concept/model providers. The confirmation flag authorizes one real concept submission and one real model submission; optional feedback adds its explicit planning/editing operations.

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --text \
  --prompt "A 100 x 100 x 12 mm flat wooden coaster with a shallow top pocket, no undercuts, and simple rounded outside corners." \
  --height-mm 12 \
  --use "CNC 3-axis candidate" \
  --confirm-cost
```

This produces a **CNC candidate**, not verified CNC tooling or a certified machinable part. The actual audit reports measured dimensions; specifying 100 × 100 mm in the prompt does not prove those exact widths were achieved. Cutter reach, pocket depth, stock/setup, minimum radii, undercuts, tolerances, toolpaths, feeds/speeds, and machine compatibility must remain `not_checked` unless independently implemented and measured. Inspect actual files before machining.

## Evidence and limits

Results default to `artifacts/live/<run-id>/`; `--output /absolute/path/results` chooses another folder. `run.json` records safe IDs and idempotency keys as stages complete. On success, `result.json` records the verified outer ZIP hash, hashes/lengths of its original GLB, normalized GLB and STL, separate physical checks, visual evaluation metadata and the approved revision/decision IDs. The runner also saves the genuine ZIP, its three geometry files and audit. Signed URLs, cookies, passwords, provider credentials, prompts and provider error bodies are not logged or saved.

The existing client verifies upload bytes and downloaded ZIP SHA-256/length. The runner additionally verifies ZIP CRCs, geometry file hashes/lengths against persisted artifact receipts, and the packaged audit's source/output hashes against those exact files. It keeps `fail` and `not_checked` physical results visible. A downloadable package is preparation evidence, not manufacturing certification. Wall thickness, self-intersections, supports and material strength remain unavailable unless actually implemented and checked.

Default waiting is at most 180 job reads separated by five seconds; individual HTTP requests have a 150 second timeout. `--max-polls` and `--poll-ms` adjust the bounded wait. On timeout, API error or `submission_unknown`, the runner stops. Existing server jobs may continue. Inspect the saved IDs in the app and reconcile the saved idempotency keys before any new paid submission. Re-running this command creates a new run; it is not a resume command.

The runner's `--help`, typecheck and lint can be verified without a live deployment. A successful local check does not prove provider generation, database configuration or deployment behavior; retain a genuine `result.json` and files from the live run as that evidence.

## Independently verify actual geometry

```sh
pnpm exec tsx scripts/inspect-live.mts --dir artifacts/live/<run> --height-mm 120
pnpm exec tsx scripts/inspect-live.mts --dir artifacts/live/<cnc-run> --width-mm 100 --depth-mm 100 --height-mm 12
```

This performs no network requests or rescaling. It reloads the real GLB and STL using independent matrix/loader code, checks file hashes, grounding, units/axis conversion and requested dimensions, then writes `measurement.json`. Height is required; width/depth are checked only when explicitly supplied. Deviations over 0.1 mm cause exit status 1 and remain failed, even if implemented topology checks passed. No CNC toolpaths or machining verification are inferred.

## Verified request spending

`run.json` records each observed job's provider request ID and separately labeled `estimatedCostUsd`. After success or a stopped run, the runner makes read-only requests to fal's **billed event feed**, filtered to those exact request IDs. It does not infer spending from the price table, the budget allowance, a reservation, credit balance, or a before/after account balance. The [official billing-events API](https://fal.ai/docs/platform-apis/v1/models/billing-events) defines `cost_total` as USD charged after discounts. Its [current OpenAPI schema](https://api.fal.ai/v1/openapi.json) defines `cost_estimate_nano_usd` as the precision-preserving amount **charged** in nano USD, despite the historical field name.

The runner reads `FAL_BILLING_KEY` locally, falling back to `FAL_KEY`; it never uploads a billing key to MakeReady or includes it in arguments, receipts, or logs. Billing access requires `billing:usage:read`, `auth:keys:read`, and `account:users:read`, available in fal's `BILLING`/`FULL` presets. A read-only probe of the current inference key on 12 October 2026 returned HTTP 403: actual spending is unavailable with that key until an appropriately permitted key is supplied.

`costs.fal.requests[]` contains safe request IDs, billed units and unit names, USD before/after discounts, and timestamps. `costs.fal.actualSpentUsd` is populated only when every observed fal request has complete, consistent billed USD evidence. With partial evidence, `verifiedSubtotalUsd` gives only the known subtotal and `actualSpentUsd` remains `null`. Unknown submission IDs, delayed billing records, denied access, invalid records, and pagination errors remain explicit statuses; none is reported as zero cost. Duplicate request IDs count once in the fal total.

`totalActualSpentUsd` remains `null`: this collector does not verify separate LLM design, planning, or visual-critique charges. The fal subtotal must not be presented as the entire workflow cost. `estimatedJobReservationsUsd` remains an estimate. A valid package can be saved even when billing is unavailable.

Refresh delayed billing evidence without another model generation:

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --collect-costs /absolute/path/results/run.json
```

This mode needs neither `APP_URL`, `DEMO_PASSWORD`, nor `--confirm-cost`. It only calls the fixed fal billing endpoint, writes a sanitized `billing.json` beside the saved receipt (`--output` can choose another directory), and leaves the original run and model files intact. Raw vendor bodies, auth metadata, signed URLs, and credentials are discarded. No paid POST is retried or initiated by billing collection.
