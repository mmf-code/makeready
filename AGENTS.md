<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Parallel ownership

- Codex owns src/lib/**, src/app/api/**, src/proxy.ts, supabase/**, tests/**, scripts/**, docs/**, package/lock files, env and deployment.
- Claude owns all other src/app/** paths, src/components/**, src/hooks/**, components.json and src/lib/utils.ts.
- Scaffold creates the default frontend once. Codex never edits frontend paths afterward.
- During Claude's shadcn init, Codex must not change package files or the lockfile. Additional dependencies go through the main Codex agent after initialization.
- No React imports or JSX in src/lib. The generated MCP HTML string is a bundled resource, not handwritten UI.
- Stage and commit explicit owned paths only. Never git add -A, commit -a, revert or reformat another owner's files.
- Providers own adapters only; main owns DB claims/finalization. UI fixtures must be visibly labeled and never enter real flows.
