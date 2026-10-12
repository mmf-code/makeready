# Deploy and verify MakeReady

Use the dedicated **makeready** Vercel and **MakeReady** Supabase projects. Web and MCP share this database and private storage bucket. Do not point these commands at EVRE or CrafThinkERA.

## Credentials and project identity

Keep runtime values in the process environment or ignored `.env.local`, using the names in `.env.example`. Do not paste secret values into command arguments, Git, screenshots, or logs. The scripts load `.env.local` without writing it, suppress subprocess/API response bodies, and print status, variable names, and acceptance session IDs only.

Required runtime values for the photo-only MVP: `FAL_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DEMO_PASSWORD`, `SESSION_SECRET`, `MCP_SECRET`, `EXECUTOR_SECRET`. Text-to-design and feedback planning/refinement remain unavailable until either `OPENAI_API_KEY` or the explicit alternative `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` is configured. An incomplete explicitly configured custom endpoint fails configuration; it never silently switches providers. A custom endpoint defaults to `LLM_API_STYLE=chat_completions`; `responses` is also supported when the endpoint implements it. The three signing/path/executor secrets need at least 32 characters. The storage bucket remains `makeready`; the hard application budget is at most $50. `OPENAI_MODEL` is unused and is not synced.

Vercel CLI must already be authenticated and this directory explicitly linked. The configuration script checks `.vercel/project.json`, then runs `vercel project inspect` and verifies the remote name and project ID before any write. It selects the Next.js framework preset during apply. Environment sync uses authenticated `vercel api` requests to `POST /v10/projects/:id/env?upsert=true`, with sensitive values in a JSON body over stdin. Omitting `gitBranch` applies Preview variables to all branches. Readback uses `decrypt=false` and verifies only names, targets, sensitive type, and branch scope. Values never appear in `--value` or `--token` arguments or printed API responses. [Vercel environment API](https://vercel.com/docs/rest-api/reference/endpoints/projects/create-one-or-more-environment-variables)

To configure only the verified dedicated project's Next.js preset and make its preview reachable by ChatGPT/webhooks, without touching env or database:

```sh
pnpm exec tsx scripts/configure-deployment.mts --apply --project-only --public-preview
```

`--public-preview` explicitly removes that project's Vercel SSO protection (`ssoProtection: null`). MakeReady's own password cookie, MCP path secret, webhook signature, and executor secret remain the access checks. This switch is never applied to another linked project. Omit `--apply` for a read-only inspection.

Set distinct `PREVIEW_APP_URL` and `PRODUCTION_APP_URL` to the public HTTPS origins you intend to use. Production requires its explicit variable; local `APP_URL=http://localhost:3000` is never copied to a deployment. `APP_URL` within each Vercel environment receives that environment's origin.

## Early transport-only preview

Before Supabase is available, set the four access variables and the explicit public `PREVIEW_APP_URL`, then run:

```sh
pnpm exec tsx scripts/configure-deployment.mts --apply --bootstrap --environment=preview --public-preview
```

Bootstrap syncs only access values, the preview origin, budget, and any complete existing provider configuration. It accepts no database/cron/production options and does not imply working generation or persistence. Deploy current source afterward. If the preview URL is not known, create the initial preview, take its returned origin, then bootstrap and deploy again. No secret values need to be placed in command arguments.

## Database setup and environment sync

A Supabase service/secret key permits application API operations; **it cannot apply SQL migrations**. Automated DDL requires a scoped `SUPABASE_ACCESS_TOKEN` with project-settings read and database-write access. The script confirms the project ref from `SUPABASE_URL` against Management API project metadata and requires the exact MakeReady name. A direct PostgreSQL connection or the dedicated dashboard SQL editor is the alternative. [Supabase Management API](https://supabase.com/docs/reference/api/introduction)

Read-only validation:

```sh
pnpm exec tsx scripts/configure-deployment.mts --check --environment=preview --migrate --cron
```

Before requesting cron configuration, set `RECONCILIATION_APP_URL` to the chosen deployed origin; it must match one selected environment. The shared Supabase store has one named reconciliation schedule. Switching its origin is an explicit operation, rather than an incidental preview/prod environment sync.

Apply the initial migration, Vault values, every-minute reconciliation, Next.js preset, and preview environment variables:

```sh
pnpm exec tsx scripts/configure-deployment.mts --apply --environment=preview --migrate --cron
```

`--environment=production` targets production; `--environment=all` requires both explicit origins. Omit `--migrate`/`--cron` when only syncing environment variables. Migrations run transactionally and are recorded with SHA-256 in `makeready_schema_migrations`; changed checksums fail. Repeated environment sync replaces only the named MakeReady variables. API/CLI failures stop the script; partial successful configuration remains in the dedicated project and can be resumed.

Without a management token, use the **MakeReady dashboard SQL editor** to run the versioned SQL in `supabase/migrations`. Create the Vault secrets `makeready_app_url` and `makeready_executor_secret`, then run `supabase/setup-reconciliation.sql`. Set `SUPABASE_PROJECT_NAME=makeready` only after confirming the dashboard identity, and run environment sync without `--migrate`/`--cron`. This is an explicit dashboard assertion; the script cannot independently verify the project name from a service key. Do not later rerun an already applied manual migration through the automated ledger without reconciling its exact checksum. [Vault](https://supabase.com/docs/guides/database/vault), [scheduled invocation](https://supabase.com/docs/guides/functions/schedule-functions)

The same values can be pasted into the dedicated Vercel project's Environment Variables screen if CLI access is unavailable. Set `APP_URL` separately for each environment. Keep the management token local; it is never uploaded to Vercel.

## Source deployment and live proof

Environment changes apply to **new deployments**. Deploy the intended current source after checks; a redeploy of an older source archive does not include local changes.

```sh
pnpm typecheck
pnpm test
pnpm build:mcp-view
pnpm build
vercel deploy --yes
```

Use `vercel deploy --prod --yes` for the separately configured production target. The public app gate protects paid web routes. Vercel Deployment Protection is a different gate: ChatGPT, fal webhooks, and Supabase reconciliation need access to their independently authenticated endpoints. A protected preview cannot prove those integrations merely because a signed-in developer can open it. `verify-live` can accept a local `VERCEL_PROTECTION_BYPASS` header credential for bounded verification; that does not configure provider or ChatGPT access.

Set local `APP_URL` to the exact deployment origin being verified, then run:

```sh
pnpm exec tsx scripts/verify-live.mts
```

This makes no paid calls. It proves the web access gate, signed cookie, real database session create/reload, seven MCP tools, and reading the **same session** through MCP. It prints no MCP endpoint secret or cookie. A missing frontend bundle is reported as unavailable; use `--require-view` once Claude's entry is bundled to require the real HTML resource. It does not prove ChatGPT rendering or real generation/export.

Before database credentials are available, `--transport-only` exercises the real web gate/cookie and MCP discovery while explicitly reporting that the database/shared-session path was not exercised. It performs no database writes and is suitable for the initial localhost/preview check.

Optional Playwright HTTP acceptance:

```sh
pnpm test:e2e
```

Set `MAKEREADY_E2E_BASE_URL`, `MAKEREADY_E2E_PASSWORD`, and optionally a genuine `MAKEREADY_E2E_SESSION_ID`. Tests skip missing prerequisites, never submit paid work, and do not record credential-bearing traces.

For complete delivery, additionally show a real provider job, verified textured GLB/STL/package files, a genuine refinement pair, and a fresh ChatGPT tool/widget session. Keep implementation, deployment, API acceptance, and live ChatGPT evidence distinct.
