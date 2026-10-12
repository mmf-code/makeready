# MakeReady — Design, Critique, Refine, Make

Independent hackathon application built from scratch on 12 October 2026. Web and MCP expose one application service and one durable project tree. No CrafThinkERA or EVRE source code, prompts, commercial data or assets were copied. The handoff archive was read as historical requirements; the newer architecture and ownership decisions take precedence.

## Run

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill server credentials and random access/session/MCP/executor secrets.
pnpm dev
```

Use a dedicated MakeReady Supabase project. Apply `supabase/migrations/202610120001_makeready.sql` and configure `supabase/setup-reconciliation.sql`. See [deployment](docs/DEPLOYMENT.md), [persistence](docs/PERSISTENCE.md) and the [frontend contract](docs/FRONTEND_CONTRACT.md).

Claude develops the frontend in the same working tree. Codex owns the backend, typed client, geometry, tests and deployment. `src/lib/utils.ts` is the explicit shadcn exception. Provider keys remain server-side.

## Workflow

1. Create a session. Optionally upload an image directly to private storage and verify the stored file.
2. Start a durable concept job. Text input uses a configured LLM and fal to create an actual image. An uploaded photo becomes the initial concept with a specification from the user's prompt, purpose and height, without an LLM call.
3. Save an observable change/preserve/action/reason plan from feedback. Execution uses that exact plan and a stable idempotency key.
4. Approve an exact concept revision, then start real fal Hunyuan3D generation.
5. A leased server executor polls, ingests original bytes, prepares geometry, audits and packages real files. A manufacturing revision is committed only after its artifacts exist and are verified.
6. Read the full session tree to restore the timeline after reconnecting. Read routes never submit or advance paid work.

## Durable paid jobs

- Jobs are separate from immutable revisions. Request IDs, ambiguity, polling, per-artifact checkpoints, leases and fenced writes live in job records.
- A database transaction reserves a cost allowance before dispatch. Idempotency binds one input fingerprint to one job.
- `submission_unknown` is an intentional hold. Ambiguous paid submissions are never automatically resubmitted.
- Cost allowances are conservative application accounting, not provider invoices. Received LLM response IDs and token usage are recorded. Provider account limits are separate.
- One generation attempt is currently made per execution, within the two-attempt ceiling per feedback. No automatic second-candidate loop is implemented. Polling is separate from generation attempts.
- Verified fal webhooks accelerate completion. Supabase Cron reconciles without an open browser. Next.js `after()` reduces latency but is not the durability mechanism. The cron must actually be installed for autonomous progress.

## Geometry and files

- `source.glb`: exact original provider bytes.
- `normalized.glb`: decoded scene wrapped with uniform scale and translation. Textures/materials are retained while glTF is reserialized; this file is not byte-identical to the original.
- The object is centered in X/Z, grounded at Y=0 and scaled to target height. GLB uses **meters, Y-up**.
- Binary `model.stl` uses the same world-space triangles converted to **millimeters, Z-up** (`x, -z, y`). STL has geometry only and no unit metadata.
- ZIP includes both GLBs, STL, public/detailed audits, manifest and production notes.
- Implemented checks cover bounds, positional welding, boundary/nonmanifold edges, vertex fans, winding, degenerate/duplicate triangles, components and unused vertices. Wall thickness, self-intersections, supports and strength remain visibly `not_checked`.
- Parseable geometry with failed physical checks can become a revision for further critique. Missing, corrupted or unsupported artifacts stop finalization.
- No printability certification, regional feature percentage, physical order or maker acceptance is claimed. Files have a 50 MB demo storage limit.

## Evaluations

Visual, deterministic physical and human evaluations remain separate, without a combined score. Image critique cannot certify 3D fidelity. Comparisons preserve parent/child lineage, actual measured differences, visual observations and limitations. The UI uses matched front/side/three-quarter camera presets; automated multi-angle render comparison is not implemented. Bounding-box changes do not prove that ears shrank or a face was preserved.

Photo → approval → 3D → Make Package works without LLM billing. Text creation and feedback planning need configured LLM access. Model-preview visual critique is optional and defaults off; enable it explicitly with `ENABLE_MODEL_VISUAL_CRITIQUE=true`. A skipped visual check remains visible as not checked.

## MCP App

Seven typed tools use Streamable HTTP at `/api/mcp/<MCP_SECRET>`. Paid tools require `confirm_cost: true` and an idempotency key. This demo uses a long random secret path; OAuth is not implemented. Keep the connector URL private.

Claude owns `src/components/mcp-view/entry.tsx` and its host bridge. `pnpm build:mcp-view` bundles the actual entry and Tailwind into a self-contained hashed resource. Without an entry, tools work but no pretend View is advertised. A ChatGPT host connection needs live verification independently of local protocol tests.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build:mcp-view
pnpm build
MAKEREADY_E2E_BASE_URL=http://127.0.0.1:3000 pnpm test:e2e
```

Geometry tests parse/export real GLB/STL bytes. Provider tests mock network boundaries; they do not prove live generation. HTTP acceptance tests use a real running application; authenticated persistence needs configured Supabase. Fixtures are Zod-validated development data and must be visibly labeled outside the real flow.
