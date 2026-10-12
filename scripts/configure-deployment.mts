import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const migrate = args.has("--migrate");
const configureCron = args.has("--cron");
const projectOnly = args.has("--project-only");
const publicPreview = args.has("--public-preview");
const bootstrap = args.has("--bootstrap");
const environmentArgument = process.argv.find((arg) => arg.startsWith("--environment="))?.split("=")[1] ?? "preview";
const targets = environmentArgument === "all" ? ["preview", "production"] : [environmentArgument];
const accessKeys = ["DEMO_PASSWORD", "SESSION_SECRET", "MCP_SECRET", "EXECUTOR_SECRET"] as const;
const requiredKeys = ["FAL_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", ...accessKeys] as const;

async function main() {
  if (targets.some((target) => target !== "preview" && target !== "production")) fail("Use --environment=preview, production, or all.");
  for (const argument of args) if (!["--apply", "--migrate", "--cron", "--check", "--project-only", "--public-preview", "--bootstrap"].includes(argument) && !argument.startsWith("--environment=")) fail("Unknown configuration argument.");
  if (projectOnly && (migrate || configureCron)) fail("--project-only cannot apply database or cron changes.");
  if (bootstrap && (projectOnly || migrate || configureCron || targets.length !== 1 || targets[0] !== "preview")) fail("--bootstrap only configures preview transport; omit database, cron, production, and project-only options.");
  const link = JSON.parse(await readFile(join(root, ".vercel/project.json"), "utf8")) as { projectName?: string; projectId?: string; orgId?: string };
  if (link.projectName !== "makeready" || !link.projectId?.startsWith("prj_") || !link.orgId) fail("Link this directory explicitly to the dedicated makeready Vercel project first.");
  const inspection = await cli(["project", "inspect", "--non-interactive", "--no-color"], undefined, true);
  if (!inspection.includes(link.projectId) || !/\bName\s+makeready(?:\s|$)/m.test(inspection)) fail("The remote Vercel project does not match the local makeready link.");
  console.info("vercel_project: VERIFIED makeready");
  if (projectOnly) {
    await configureProject(link.projectId, link.orgId);
    console.info(`project_metadata: ${apply ? "COMPLETE" : "CHECK_ONLY"} (no environment or database writes)`);
    return;
  }
  if (bootstrap) {
    const missing = accessKeys.filter((key) => !process.env[key]);
    if (missing.length) fail(`Missing environment variable names: ${missing.join(", ")}.`);
    validateAccessSecrets();
    const budget = configuredBudget();
    const origin = publicOrigin(process.env.PREVIEW_APP_URL, "PREVIEW_APP_URL");
    const values: Record<string, string> = Object.fromEntries(accessKeys.map((key) => [key, process.env[key]!]));
    Object.assign(values, { APP_URL: origin, MAKE_BUDGET_USD: String(budget) }, languageEnvironment(false));
    if (process.env.FAL_KEY?.trim()) values.FAL_KEY = process.env.FAL_KEY;
    if (process.env.MESHY_API_KEY?.trim()) values.MESHY_API_KEY = process.env.MESHY_API_KEY;
    console.info("configuration: BOOTSTRAP_VALIDATED preview (database and generation remain unavailable until full setup)");
    if (!apply) { console.info("mode: CHECK_ONLY (no external writes)"); return; }
    await configureProject(link.projectId, link.orgId);
    await syncEnvironment(link.projectId, link.orgId, "preview", values);
    console.info("bootstrap: COMPLETE (deploy new source separately; no database writes)");
    return;
  }

  const missing = requiredKeys.filter((key) => !process.env[key]);
  if (missing.length) fail(`Missing environment variable names: ${missing.join(", ")}.`);
  validateAccessSecrets();
  const budget = configuredBudget();
  const llmValues = languageEnvironment(false);
  if ((process.env.SUPABASE_STORAGE_BUCKET ?? "makeready") !== "makeready") fail("The frozen migration requires the dedicated makeready artifact bucket.");
  const supabaseUrl = new URL(process.env.SUPABASE_URL!);
  if (supabaseUrl.protocol !== "https:" || !/^[a-z]{20}\.supabase\.co$/.test(supabaseUrl.hostname) || supabaseUrl.username || supabaseUrl.password || supabaseUrl.pathname !== "/" || supabaseUrl.search || supabaseUrl.hash) fail("SUPABASE_URL must be the dedicated project's standard HTTPS URL.");
  const reference = supabaseUrl.hostname.split(".")[0];
  if (process.env.SUPABASE_PROJECT_REF && process.env.SUPABASE_PROJECT_REF !== reference) fail("SUPABASE_PROJECT_REF does not match SUPABASE_URL.");
  await verifySupabaseServerAccess(supabaseUrl);

  const urls = new Map(targets.map((target) => {
    const configured = target === "production" ? process.env.PRODUCTION_APP_URL : process.env.PREVIEW_APP_URL ?? process.env.APP_URL;
    return [target, publicOrigin(configured, target === "production" ? "PRODUCTION_APP_URL" : "PREVIEW_APP_URL")];
  }));
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (migrate || configureCron) {
    if (!token) fail("Database setup needs SUPABASE_ACCESS_TOKEN. A Supabase service/secret API key cannot run DDL; use the dedicated project's SQL editor or a database connection instead.");
  }
  if (token) {
    const projects = await management("/v1/projects", token) as { ref?: string; id?: string; name?: string }[];
    const project = projects.find((item) => (item.ref ?? item.id) === reference);
    if (!project || project.name?.toLowerCase() !== "makeready") fail("The Supabase Management API did not confirm an exact dedicated MakeReady project name. Refusing to target EVRE/CrafThinkERA or an unknown project.");
    console.info("supabase_project: VERIFIED MakeReady");
  } else {
    if (process.env.SUPABASE_PROJECT_REF === reference) {
      console.info("supabase_project: EXPLICIT_REF_CONFIRMED (management project name not independently verified)");
    } else {
      if (process.env.SUPABASE_PROJECT_NAME?.toLowerCase() !== "makeready") fail("Without a management token, explicitly confirm SUPABASE_PROJECT_REF or set SUPABASE_PROJECT_NAME=makeready after checking the dedicated project.");
      console.info("supabase_project: DASHBOARD_ASSERTED makeready (management identity not independently verified)");
    }
  }
  const migrationFiles = (await readdir(join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
  if (migrate && migrationFiles.length === 0) fail("No versioned MakeReady migrations exist.");
  const cronOrigin = configureCron ? publicOrigin(process.env.RECONCILIATION_APP_URL, "RECONCILIATION_APP_URL") : undefined;
  if (cronOrigin && ![...urls.values()].includes(cronOrigin)) fail("RECONCILIATION_APP_URL must match one of the explicitly selected deployment origins.");
  console.info(`configuration: VALIDATED ${targets.join(",")} migrations=${migrate ? migrationFiles.length : "not requested"} cron=${configureCron ? "requested" : "not requested"}`);
  if (!apply) { console.info("mode: CHECK_ONLY (no external writes)"); return; }

  if (migrate) await migrateDatabase(reference, token!, migrationFiles);
  if (configureCron) {
    const vault = `create extension if not exists supabase_vault with schema vault;\n${vaultUpsert("makeready_app_url", cronOrigin!)}\n${vaultUpsert("makeready_executor_secret", process.env.EXECUTOR_SECRET!)}`;
    const schedule = await readFile(join(root, "supabase/setup-reconciliation.sql"), "utf8");
    await query(reference, token!, `${vault}\n${schedule}`);
    console.info("reconciliation: CONFIGURED every_minute");
  }
  await configureProject(link.projectId, link.orgId);
  for (const target of targets) {
    const values: Record<string, string> = Object.fromEntries(requiredKeys.map((key) => [key, process.env[key]!]));
    Object.assign(values, {
      SUPABASE_STORAGE_BUCKET: "makeready",
      MAKE_BUDGET_USD: String(budget),
      APP_URL: urls.get(target)!,
    }, llmValues);
    if (process.env.MESHY_API_KEY?.trim()) values.MESHY_API_KEY = process.env.MESHY_API_KEY;
    await syncEnvironment(link.projectId, link.orgId, target, values);
  }
  console.info("configuration: COMPLETE (deploy new source separately; existing deployments retain their environment)");
}

function validateAccessSecrets() {
  for (const key of ["SESSION_SECRET", "MCP_SECRET", "EXECUTOR_SECRET"]) if ((process.env[key]?.length ?? 0) < 32) fail(`${key} must contain at least 32 characters.`);
}

async function verifySupabaseServerAccess(url: URL) {
  const key = process.env.SUPABASE_SECRET_KEY!;
  let serviceRole = false;
  if (key.split(".").length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as { role?: unknown };
      serviceRole = claims.role === "service_role";
    } catch { /* The actual API request below verifies recognized credentials. */ }
  }
  if (!key.startsWith("sb_secret_") && !serviceRole) fail("SUPABASE_SECRET_KEY must be a secret API key or legacy service_role key, not the database password, publishable key, or management token.");
  let response: Response;
  try {
    response = await fetch(new URL("/storage/v1/bucket?limit=1", url), {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch { fail("Supabase server credential verification could not reach Storage; no configuration was written."); }
  if (!response.ok) fail(`Supabase rejected the server credential check with HTTP ${response.status}; no configuration was written. Response body suppressed.`);
  let buckets: unknown;
  try { buckets = await response.json(); } catch { fail("Supabase returned an unreadable bucket list; no configuration was written."); }
  if (!Array.isArray(buckets)) fail("Supabase did not return the expected bucket list; no configuration was written.");
  console.info("supabase_server_key: VERIFIED Storage access (no writes)");
}

function configuredBudget(): number {
  const budget = Number(process.env.MAKE_BUDGET_USD ?? "50");
  if (!Number.isFinite(budget) || budget <= 0 || budget > 50) fail("MAKE_BUDGET_USD must be greater than zero and at most 50.");
  return budget;
}

function languageEnvironment(required: boolean): Record<string, string> {
  const custom = process.env.LLM_BASE_URL?.trim();
  if (process.env.LLM_API_STYLE?.trim() === "anthropic") {
    const key = process.env.LLM_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
    const model = process.env.LLM_MODEL?.trim();
    if (!key || !model) fail("Anthropic mode requires LLM_API_KEY or ANTHROPIC_API_KEY, plus an explicit LLM_MODEL. It never falls back to OpenAI.");
    if (!key.startsWith("sk-ant-")) fail("Anthropic mode requires an Anthropic API key; credentials for other providers are not forwarded.");
    if (custom && !["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/"].includes(custom)) fail("Anthropic mode only permits the official https://api.anthropic.com/v1 endpoint.");
    return { LLM_API_KEY: key, LLM_MODEL: model, LLM_BASE_URL: "https://api.anthropic.com/v1", LLM_API_STYLE: "anthropic" };
  }
  if (process.env.LLM_API_KEY?.trim().startsWith("sk-ant-") || process.env.ANTHROPIC_API_KEY?.trim()) fail("Select LLM_API_STYLE=anthropic before configuring an Anthropic key; it is never sent to another provider.");
  if (custom) {
    const key = process.env.LLM_API_KEY?.trim();
    const model = process.env.LLM_MODEL?.trim();
    if (!key || !model) fail("A custom LLM_BASE_URL requires explicit LLM_API_KEY and LLM_MODEL; incomplete custom configuration is never silently replaced.");
    const url = new URL(custom);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("LLM_BASE_URL must be an HTTPS API URL without credentials, query, or fragment.");
    const style = process.env.LLM_API_STYLE?.trim() || "chat_completions";
    if (style !== "responses" && style !== "chat_completions") fail("LLM_API_STYLE must be responses or chat_completions.");
    return { LLM_BASE_URL: custom, LLM_API_KEY: key, LLM_MODEL: model, LLM_API_STYLE: style };
  }
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    if (required) fail("Configure native Anthropic, OPENAI_API_KEY, or an explicit compatible LLM endpoint.");
    return {};
  }
  const values: Record<string, string> = { OPENAI_API_KEY: key };
  if (process.env.LLM_MODEL?.trim()) values.LLM_MODEL = process.env.LLM_MODEL.trim();
  if (process.env.LLM_API_STYLE?.trim()) {
    if (!["responses", "chat_completions"].includes(process.env.LLM_API_STYLE.trim())) fail("LLM_API_STYLE must be responses or chat_completions.");
    values.LLM_API_STYLE = process.env.LLM_API_STYLE.trim();
  }
  return values;
}

async function syncEnvironment(projectId: string, orgId: string, target: string, values: Record<string, string>) {
  const endpoint = `/v10/projects/${encodeURIComponent(projectId)}/env`;
  const team = `teamId=${encodeURIComponent(orgId)}`;
  for (const [name, value] of Object.entries(values)) {
    // Omit gitBranch explicitly: preview values apply to all Preview branches.
    // Values travel only in the JSON body over stdin, never arguments or logs.
    const response = JSON.parse(await cli([
      "api", `${endpoint}?upsert=true&${team}`, "--method", "POST", "--input", "-", "--raw", "--non-interactive",
    ], JSON.stringify({ key: name, value, type: "sensitive", target: [target] }))) as { failed?: unknown[]; error?: unknown };
    if (response.error || (response.failed?.length ?? 0) > 0) fail(`Vercel environment sync failed for ${name}; response body suppressed.`);
    console.info(`environment: SYNCED ${target} ${name}`);
  }
  const response = JSON.parse(await cli(["api", `${endpoint}?decrypt=false&${team}`, "--raw", "--non-interactive"])) as {
    envs?: { key?: string; type?: string; target?: string[]; gitBranch?: string | null }[];
  };
  for (const name of Object.keys(values)) {
    const matches = response.envs?.filter((entry) => entry.key === name && !entry.gitBranch && entry.target?.includes(target)) ?? [];
    if (matches.length !== 1 || matches[0].type !== "sensitive" || matches[0].target?.length !== 1) fail(`Vercel environment metadata verification failed for ${name}; response body suppressed.`);
    console.info(`environment: VERIFIED ${target} ${name} all_branches sensitive`);
  }
}

async function configureProject(projectId: string, orgId: string) {
  const endpoint = `/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(orgId)}`;
  const metadata = JSON.parse(await cli(["api", endpoint, "--raw", "--non-interactive"])) as {
    id?: string; name?: string; framework?: string; ssoProtection?: unknown; passwordProtection?: unknown;
  };
  if (metadata.id !== projectId || metadata.name !== "makeready") fail("Remote project metadata did not match the dedicated makeready project.");
  if (publicPreview && metadata.passwordProtection) fail("The dedicated project has an additional Vercel password gate; inspect that project setting before enabling public integrations.");
  console.info(`vercel_framework: ${metadata.framework === "nextjs" ? "VERIFIED nextjs" : "NEEDS_NEXTJS"}`);
  console.info(`vercel_sso: ${metadata.ssoProtection ? "ENABLED" : "DISABLED"}`);
  if (!apply) return;
  const changes: Record<string, unknown> = {};
  if (metadata.framework !== "nextjs") changes.framework = "nextjs";
  if (publicPreview && metadata.ssoProtection) changes.ssoProtection = null;
  if (Object.keys(changes).length) {
    await cli(["api", endpoint, "--method", "PATCH", "--input", "-", "--non-interactive"], JSON.stringify(changes));
    console.info(`vercel_metadata: UPDATED ${Object.keys(changes).join(",")}`);
  } else console.info("vercel_metadata: ALREADY_CONFIGURED");
}

async function migrateDatabase(reference: string, token: string, files: string[]) {
  await query(reference, token, "create table if not exists public.makeready_schema_migrations(name text primary key, sha256 text not null, applied_at timestamptz not null default now()); alter table public.makeready_schema_migrations enable row level security; revoke all on public.makeready_schema_migrations from public,anon,authenticated;");
  const existing = await query(reference, token, "select name,sha256 from public.makeready_schema_migrations;") as { name: string; sha256: string }[];
  for (const name of files) {
    const sql = await readFile(join(root, "supabase/migrations", name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const applied = existing.find((item) => item.name === name);
    if (applied) {
      if (applied.sha256 !== sha256) fail(`Applied migration checksum changed: ${name}.`);
      console.info(`migration: ALREADY_APPLIED ${name}`);
      continue;
    }
    if (/^\s*(?:begin|commit|rollback)\s*;/im.test(sql)) fail(`Migration ${name} must let the deployment script own its transaction.`);
    await query(reference, token, `begin;\n${sql}\ninsert into public.makeready_schema_migrations(name,sha256) values(${quote(name)},${quote(sha256)});\ncommit;`);
    console.info(`migration: APPLIED ${name}`);
  }
}

function vaultUpsert(name: string, value: string) {
  return `do $makeready_vault$ declare existing_id uuid; begin select id into existing_id from vault.secrets where name=${quote(name)}; if existing_id is null then perform vault.create_secret(${quote(value)},${quote(name)},'MakeReady reconciliation'); else perform vault.update_secret(existing_id,${quote(value)},${quote(name)},'MakeReady reconciliation'); end if; end $makeready_vault$;`;
}

function publicOrigin(value: string | undefined, name: string): string {
  if (!value) fail(`${name} is required; localhost APP_URL is never copied to a deployment.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.pathname !== "/" || url.search || url.hash) fail(`${name} must be a public HTTPS origin without credentials, path, query, or fragment.`);
  return url.origin;
}

async function management(path: string, token: string, payload?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.supabase.com${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(60_000),
    });
  } catch { fail("Supabase Management API could not be reached; no raw request or response was printed."); }
  if (!response.ok) fail(`Supabase Management API returned HTTP ${response.status}; inspect the dedicated project dashboard. Response body suppressed.`);
  try { return await response.json(); } catch { fail("Supabase Management API returned an unreadable response."); }
}

function query(reference: string, token: string, sql: string): Promise<unknown> {
  return management(`/v1/projects/${reference}/database/query`, token, { query: sql });
}

function cli(arguments_: string[], input?: string, includeStderr = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("vercel", arguments_, { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", () => reject(new Error("Vercel CLI could not start. Install/authenticate the CLI separately.")));
    child.on("close", (code) => code === 0 ? resolvePromise(includeStderr ? `${output}\n${stderr}` : output) : reject(new Error(`Vercel CLI ${arguments_.slice(0, 2).join(" ")} failed; subprocess output suppressed.`)));
    child.stdin.on("error", () => { /* A failed CLI may close stdin before reading. Its exit code is authoritative. */ });
    child.stdin.end(input ?? "");
  });
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function fail(message: string): never { throw new Error(message); }

main().catch((error: unknown) => {
  // All expected failures use fixed messages; never print stacks, response bodies, or env values.
  console.error(error instanceof Error && !error.message.includes("http") ? error.message : "Deployment configuration failed. Inspect variable names and dedicated project settings.");
  process.exitCode = 1;
});
