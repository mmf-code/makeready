# Actual model visual review

New 3D generation jobs render the verified `model_glb` in Node before requesting one
vision critique against the stored concept. The evidence is a labeled front (+Z),
side (+X) and three-quarter contact sheet. All cameras share one framing and scale;
the source mesh's orientation determines what those axes show. This is a review of
the child's actual geometry against an image, not a matched comparison of two GLBs.

The bounded software renderer uses world transforms, depth occlusion, base-color
materials, embedded textures, vertex colors, UVs and UV transforms. It does not
simulate PBR reflections, normal maps or shadows. Textures are sampled at at most
1024 pixels. Unsupported transparency, corrupt/missing textures, insufficient
visible geometry, excessive pixel work or a 15-second rendering limit produce an
explicit unreviewed result, never a positive verdict. No browser/GPU installation
or new runtime dependency is needed.

The image and a JSON provenance manifest are private verified storage artifacts,
held separately from the immutable model revision so they cannot be mistaken for
its concept. `evaluation.evidence` contains their receipts, renderer version and
the exact model/reference SHA-256 values. `getSession` signs their download URLs.
The manifest records camera settings, view hashes, texture hashes and limitations.
The job also retains the vision model, response ID, token usage and prompt hash.

Visual observations retain per-criterion failures, uncertainties, suggested changes
and alignment. An aligned headline cannot override a `not_met` observation; all
uncertain observations produce uncertain alignment. English is explicitly selected
for the English application, rather than inheriting a language from text in an image.
This is subjective visual inspection. Measurements and topology remain deterministic
audit/acceptance results, and human approval remains a separate record.

## Bounded execution

- One critique per generation job, checkpointed before finalization. Polling and
  recovery of a completed job do not make another paid request.
- Uniform scaling skips a redundant appearance critique and points to the parent.
- No provider-thumbnail substitution, automatic regeneration or historical backfill.
- A failed/ambiguous review preserves prepared model files, records why no verdict
  is available and disables automatic paid retry. It does not certify printability.
- A separate durable review-dispatch marker allows recovery after a killed process
  to finish the model without resending the optional vision request.
- Review remains opt-in: set `ENABLE_MODEL_VISUAL_CRITIQUE=true` for new models
  when intelligence is configured. Missing/false keeps the existing deployment
  behavior. Previously this flag opted into provider-thumbnail review; that path
  has been removed. Do not enable it in production before preview validation.
- Existing completed jobs and revisions are not changed by deploying this code.

## Review one existing model

The maintenance script defaults to local rendering and makes no paid request or
database write. It verifies the dedicated MakeReady database target:

```sh
NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/review-live-model.mts \
  --env-file /path/to/ignored/.env.local --session SESSION_UUID --revision REVISION_UUID
```

After reviewing the images, add `--apply --confirm-cost` for one vision request.
The script reserves a $0.10 application estimate within the existing scope cap;
this is not an invoice or a claim about actual USD cost. It appends a durable
dispatch marker before calling the provider, saves the response receipt even if
validation fails, then appends a new visual evaluation. Earlier `not_checked`
observations and human decisions remain immutable. Re-running the command cannot
send the same review again, including after an unknown outcome. A process crash
may leave its reservation for manual reconciliation; it must not trigger paid retry.

The script stores local evidence under ignored `artifacts/live/model-review-UUID/`.
It never generates another image/mesh, runs a migration, changes cron or deploys.
New evidence fields are additive; old production code can still read these sessions.

## Rollout

Validate rendering, failure isolation, budget/idempotency, typecheck and build in an
isolated worktree. Test a unique preview deployment without moving the stable cron
alias. Verify production authentication and existing session/package reads before
and after promoting the verified build. Do not deploy an uncommitted working tree.
