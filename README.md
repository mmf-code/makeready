<p align="center"><img src="public/hamur.svg" width="128" alt="Hamur, the MakeReady mascot"></p>

# MakeReady

One message in, a printable 3D model out.

You type "a baby chick, 70 mm tall, I want to paint it". A small crew of agents takes it from there. One writes the spec, one draws it, one looks at the drawing, one turns it into a mesh, one measures the mesh, one scales and packs it. You stay in the loop for the two calls a machine should not make alone: which drawing is right, and when to spend money on 3D.

This was built in one day for a hackathon (12 October 2026). The digital half is real: real model calls, real files, real measurements. The physical half (print shop, painter, line QA, courier) is a sandbox, and the UI labels it as one.

## what actually happens

```
"a baby chick, 70 mm"
   │
   ├─ Foreman ─────────── LLM writes a spec: object, use, height, what must stay the same
   ├─ Concept agent ───── fal (nano-banana) draws it
   ├─ Look inspector ──── LLM vision compares the drawing with the request
   │
   ├─ you: approve, or send it back with words ("bigger beak, keep the eyes")
   │     └─ Foreman writes a change order: intent, keep-list, action, measurable checks
   │        └─ Concept agent edits, v1 stays, v2 is new
   │           └─ Look inspector compares v1 and v2
   │
   ├─ Geometry agent ──── fal Hunyuan3D v3 (or Meshy 7.1): image to mesh
   ├─ Prep agent ──────── scale to height, center, ground at Y=0, GLB + STL + zip
   ├─ Shape inspector ─── bounds, welding, open/non-manifold edges, winding, degenerate tris
   ├─ acceptance ──────── every size you asked for vs. the measured bounds: met / not met
   │
   └─ sandbox makers ──── quote, print, paint, QA, courier (scripted, labeled)
```

Every arrow is a tool call. The run page shows each call with who made it, who answered, the provider request id and how long it took. The "Caught and fixed" panel strings one change order together: what was wrong, the plan, the fix, and the check that ran on the fix.

## the crew, honestly

| agent | real? | what it is |
|---|---|---|
| Foreman | yes | LLM spec and change-order writer. The orchestration around it is plain code. |
| Concept agent | yes | fal image generation and editing. An uploaded photo can be the concept directly. |
| Look inspector | yes, for drawings | LLM vision on concept images. With `ENABLE_MODEL_VISUAL_CRITIQUE=true` it also looks at the provider's preview render of the mesh. That is a picture of the mesh, not a measurement. |
| Geometry agent | yes | fal Hunyuan3D v3, or Meshy 7.1 if you pick it. No silent fallback between them. |
| Shape inspector | yes | Deterministic code on the decoded triangles. No LLM. |
| Prep agent | yes | Scaling, grounding, GLB/STL/zip. It does not repair meshes. |
| Print Studio, Elif, Line QA, Courier | no | A timed sandbox script. Quotes, prints and deliveries are made up and marked `sandbox`. |

## quick start

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local   # fal key, LLM key, Supabase project, a few random secrets
pnpm dev
```

You need a Supabase project of its own. Apply `supabase/migrations/*.sql`, then `supabase/setup-reconciliation.sql` so a cron job keeps paid work moving when nobody has the page open. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has the long version.

To drive a real run from the terminal (this spends money):

```sh
pnpm exec tsx --env-file=.env.local scripts/generate-live.mts \
  --text --prompt "A round baby chick figurine" --height-mm 70 \
  --feedback "Bigger beak, keep the eyes" --confirm-cost
```

## the parts that keep it sane

- **Paid work is a job, not a request.** Jobs live in Postgres with leases, fenced writes and per-step checkpoints. A crashed function picks up where it stopped.
- **Idempotency everywhere.** One input fingerprint maps to one job. If a submission's fate is unknown, the job stops in `submission_unknown` and is never resent on its own.
- **A budget row, checked in a transaction** before anything is dispatched. Estimates, not invoices.
- **Versions are immutable.** A change order makes v2 next to v1. Approvals bind to exact file hashes.
- **Three kinds of evaluation, never blended into one score:** visual (LLM), physical (code), human (you).

## units, because someone will ask

- `normalized.glb`: meters, Y-up, grounded at Y=0, centered in X/Z.
- `model.stl`: millimeters, Z-up, same triangles. STL has no unit field, so the manifest says it.
- `source.glb`: the provider's original bytes, untouched.

## ChatGPT / MCP

Seven tools over Streamable HTTP at `/api/mcp/<MCP_SECRET>`: `start_design`, `get_design`, `plan_refinement`, `apply_refinement`, `decide_revision`, `generate_model`, `get_make_package`. Paid tools require `confirm_cost: true` and an idempotency key. Same service, same session tree as the web app, so a run started in ChatGPT shows up live on the run page.

## not done

- The look inspector does not render the mesh from matched angles and compare it with the concept yet. Today it is a provider preview at best.
- A failed size check does not trigger an automatic second attempt. The Foreman plans, a person runs it.
- No wall thickness, self-intersection, support or strength analysis. Those show as `not_checked`, on purpose.
- Nothing here certifies that a part will print.

## layout

```
src/app/            pages and API routes (Next.js App Router)
src/components/     run page, work cell (three.js), the Hamur mascot
src/lib/            providers, executor, geometry, harness, contracts, MCP server
supabase/           migrations and the reconciliation cron
scripts/            live run, deployment and database setup
tests/              vitest + playwright
```

## tests

```sh
pnpm test        # unit and integration, providers mocked at the network edge
pnpm test:e2e    # against a running app
```

Geometry tests parse and export real GLB/STL bytes. Provider tests do not prove live generation; `scripts/generate-live.mts` does.

Built from scratch for the hackathon. No code, prompts or assets from other projects.
