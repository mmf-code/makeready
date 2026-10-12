/**
 * Dedicated MakeReady direct-PostgreSQL setup (no Management API token needed).
 *
 * pnpm exec tsx scripts/setup-database.mts --check
 * pnpm exec tsx scripts/setup-database.mts --apply --migrate
 * pnpm exec tsx scripts/setup-database.mts --apply --cron
 *
 * Reads SUPABASE_DB_URL only from the environment / ignored .env.local. Never
 * pass credentials as arguments. Targets only gsarkjadpjftvhjrfsam. All writes
 * use one transaction and project advisory lock; existing matching migrations
 * are skipped, checksum drift and untracked existing schemas are rejected.
 * Cron uses the stable preview origin and named Vault secrets, never an inline
 * bearer token. Successful cron SQL only proves an HTTP request was queued;
 * verify its HTTP response after deploying the configured runtime separately.
 */
import { createHash, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Client, ClientConfig } from "pg";

export const PROJECT_REF = "gsarkjadpjftvhjrfsam";
export const PREVIEW_ORIGIN = "https://makeready-preview-mmf-code.vercel.app";
const CA_FINGERPRINT = "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationTables = ["design_records", "design_sessions", "generation_job_events", "generation_jobs", "make_artifacts", "make_budgets"];
const vaultNames = ["makeready_app_url", "makeready_executor_secret"];

class SetupError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new SetupError(code, message); }

export function parseFlags(args: string[]) {
  const allowed = new Set(["--check", "--apply", "--migrate", "--cron"]);
  if (args.some((arg) => !allowed.has(arg))) fail("INVALID_ARGUMENT", "Use only --check or --apply with --migrate and/or --cron; credentials belong in the environment.");
  const flags = new Set(args);
  const apply = flags.has("--apply"), migrate = flags.has("--migrate"), cron = flags.has("--cron");
  if (flags.has("--check") && apply) fail("INVALID_ARGUMENT", "--check cannot be combined with --apply.");
  if ((migrate || cron) && !apply) fail("INVALID_ARGUMENT", "Requested writes require --apply.");
  if (apply && !migrate && !cron) fail("INVALID_ARGUMENT", "--apply requires --migrate and/or --cron.");
  return { apply, migrate, cron };
}

export function validateTarget(env: Record<string, string | undefined>) {
  let api: URL, database: URL;
  try { api = new URL(env.SUPABASE_URL ?? ""); database = new URL(env.SUPABASE_DB_URL ?? ""); }
  catch { return fail("INVALID_TARGET", "Set SUPABASE_URL and SUPABASE_DB_URL for the dedicated MakeReady project."); }
  if (api.origin !== `https://${PROJECT_REF}.supabase.co` || api.username || api.password || api.pathname !== "/" || api.search || api.hash) {
    fail("INVALID_TARGET", "SUPABASE_URL must exactly identify the dedicated MakeReady project.");
  }
  if (env.SUPABASE_PROJECT_REF && env.SUPABASE_PROJECT_REF !== PROJECT_REF) fail("INVALID_TARGET", "SUPABASE_PROJECT_REF does not match the approved project.");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || database.pathname !== "/postgres" || database.hash) {
    fail("INVALID_TARGET", "SUPABASE_DB_URL must be a PostgreSQL connection to the approved postgres database.");
  }
  let user: string, password: string;
  try { user = decodeURIComponent(database.username); password = decodeURIComponent(database.password); }
  catch { return fail("INVALID_TARGET", "Database credentials contain invalid URL encoding."); }
  const host = database.hostname;
  const port = Number(database.port || "5432");
  const direct = host === `db.${PROJECT_REF}.supabase.co`;
  const pooler = /^(?:aws|gcp|azure)-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if (!password || !((direct && ["postgres", `postgres.${PROJECT_REF}`].includes(user) && port === 5432)
    || (pooler && user === `postgres.${PROJECT_REF}` && [5432, 6543].includes(port)))) {
    fail("INVALID_TARGET", "Database host, username and port must identify the approved Supabase project.");
  }
  // Never let pg-connection-string reinterpret host/user/password or disable TLS.
  // Known SSL options are removed; every other URL option is rejected. Driver
  // configuration below uses explicit validated fields, not connectionString.
  const sslOptions = new Set(["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "sslcompression", "ssl_min_protocol_version", "ssl_max_protocol_version", "uselibpqcompat"]);
  for (const name of database.searchParams.keys()) {
    if (!sslOptions.has(name.toLowerCase())) fail("TRANSPORT_OVERRIDE", "Database URL query options may not override the approved connection transport.");
  }
  return { host, port, user, password, database: "postgres" };
}

export function verifiedCertificate(pem: string, now = Date.now()): string {
  let cert: X509Certificate;
  try { cert = new X509Certificate(pem); } catch { return fail("INVALID_CA", "The committed public Supabase CA could not be read."); }
  const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
  if (fingerprint !== CA_FINGERPRINT || !cert.ca || !cert.verify(cert.publicKey)
    || now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
    fail("INVALID_CA", "The public Supabase CA fingerprint, signature or validity does not match the pinned trust anchor.");
  }
  return cert.toString();
}

export function connectionConfig(target: ReturnType<typeof validateTarget>, ca: string): ClientConfig {
  return {
    ...target,
    ssl: { ca, rejectUnauthorized: true, servername: target.host, minVersion: "TLSv1.2" },
    application_name: "makeready-database-setup",
    connectionTimeoutMillis: 15_000,
    statement_timeout: 45_000,
    query_timeout: 50_000,
    idle_in_transaction_session_timeout: 60_000,
  };
}

export function cronOrigin(env: Record<string, string | undefined>): string {
  const configured = env.RECONCILIATION_APP_URL ?? env.PREVIEW_APP_URL ?? PREVIEW_ORIGIN;
  let url: URL;
  try { url = new URL(configured); } catch { return fail("INVALID_CRON_ORIGIN", "Reconciliation requires the approved stable preview HTTPS origin."); }
  if (url.origin !== PREVIEW_ORIGIN || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("INVALID_CRON_ORIGIN", "Reconciliation may target only the approved stable MakeReady preview origin.");
  }
  return url.origin;
}

type Migration = { name: string; sha256: string; sql: string };
type MigrationState = { name: string; sha256: string; status: "APPLIED_MATCH" | "MISSING" | "CHECKSUM_MISMATCH" };
export function migrationStates(local: Pick<Migration, "name" | "sha256">[], applied: { name: string; sha256: string }[]): MigrationState[] {
  return local.map((file) => {
    const current = applied.find((entry) => entry.name === file.name);
    return { name: file.name, sha256: file.sha256, status: !current ? "MISSING" : current.sha256 === file.sha256 ? "APPLIED_MATCH" : "CHECKSUM_MISMATCH" };
  });
}

async function loadMigrations(): Promise<Migration[]> {
  const directory = join(root, "supabase/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (!files.length) fail("NO_MIGRATIONS", "No versioned MakeReady migration files exist.");
  return Promise.all(files.map(async (name) => {
    const bytes = await readFile(join(directory, name));
    const sql = bytes.toString("utf8");
    if (/^\s*(?:begin|commit|rollback)\s*;/im.test(sql)) fail("NESTED_TRANSACTION", "Versioned migrations must not contain their own transaction boundaries.");
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), sql };
  }));
}

const normalizedSql = (value: string) => value.trim().replace(/\s+/g, " ");
function cronCommand(sql: string) {
  const match = sql.match(/\$\$([\s\S]*?)\$\$/);
  if (!match) fail("INVALID_CRON_SQL", "Reconciliation SQL does not contain the expected schedule command.");
  return normalizedSql(match[1]);
}

async function inspect(client: Client, files: Migration[], scheduleSql: string) {
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = '45s'");
    const tables = (await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' and tablename=any($1::text[]) order by tablename", [[...applicationTables, "makeready_schema_migrations"]])).rows.map((row) => row.tablename);
    const applied = tables.includes("makeready_schema_migrations")
      ? (await client.query<{ name: string; sha256: string }>("select name,sha256 from public.makeready_schema_migrations order by name")).rows : [];
    const bucketExists = (await client.query<{ found: boolean }>("select to_regclass('storage.buckets') is not null as found")).rows[0].found;
    const bucket = bucketExists ? (await client.query<{ id: string; public: boolean; file_size_limit: string | null }>("select id,public,file_size_limit::text from storage.buckets where id='makeready'")).rows : [];
    const extensions = (await client.query<{ extname: string }>("select extname from pg_extension where extname=any($1::text[]) order by extname", [["pg_cron", "pg_net", "supabase_vault"]])).rows.map((row) => row.extname);
    const cronExists = (await client.query<{ found: boolean }>("select to_regclass('cron.job') is not null as found")).rows[0].found;
    const jobs = cronExists ? (await client.query<{ jobid: string; jobname: string; schedule: string; active: boolean; command: string }>("select jobid::text,jobname,schedule,active,command from cron.job where jobname='makeready-reconcile' order by jobid")).rows : [];
    const vaultExists = (await client.query<{ found: boolean }>("select to_regclass('vault.secrets') is not null as found")).rows[0].found;
    const vault = vaultExists ? (await client.query<{ name: string; count: number }>("select name,count(*)::int as count from vault.secrets where name=any($1::text[]) group by name order by name", [vaultNames])).rows : [];
    const runTable = (await client.query<{ found: boolean }>("select to_regclass('cron.job_run_details') is not null as found")).rows[0].found;
    const runs = runTable && jobs.length ? (await client.query<{ jobid: string; status: string; start_time: string; end_time: string | null }>("select jobid::text,status,start_time::text,end_time::text from cron.job_run_details where jobid=any($1::bigint[]) order by start_time desc limit 3", [jobs.map((job) => job.jobid)])).rows : [];
    await client.query("commit");
    return {
      project: PROJECT_REF,
      tls: "VERIFIED_CA_AND_HOSTNAME",
      tables,
      migrations: migrationStates(files, applied),
      bucket,
      extensions,
      cron: jobs.map(({ command, ...job }) => ({ ...job, commandMatches: normalizedSql(command) === cronCommand(scheduleSql) })),
      vault,
      cronSqlRuns: runs,
      httpVerification: "NOT_PERFORMED: successful cron SQL means queued HTTP, not an HTTP success response",
    };
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
}

async function beginSetup(client: Client) {
  await client.query("begin");
  await client.query("set local statement_timeout = '45s'");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`makeready:setup:${PROJECT_REF}`]);
}

async function applyMigrations(client: Client, files: Migration[]) {
  await beginSetup(client);
  try {
    const tableState = (await client.query<{ tracked: boolean; existing: boolean }>("select to_regclass('public.makeready_schema_migrations') is not null as tracked, exists(select 1 from pg_tables where schemaname='public' and tablename=any($1::text[])) as existing", [applicationTables])).rows[0];
    if (!tableState.tracked && tableState.existing) fail("UNTRACKED_SCHEMA", "MakeReady tables exist without a migration ledger. Inspect their provenance before applying migrations.");
    await client.query(`create table if not exists public.makeready_schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now()
    );
    alter table public.makeready_schema_migrations enable row level security;
    revoke all on public.makeready_schema_migrations from public,anon,authenticated;
    grant select on public.makeready_schema_migrations to service_role;`);
    const applied = (await client.query<{ name: string; sha256: string }>("select name,sha256 from public.makeready_schema_migrations order by name")).rows;
    if (!applied.length && tableState.existing) fail("UNTRACKED_SCHEMA", "Existing MakeReady tables have no recorded migration. Refusing to assume ownership of that schema.");
    const states = migrationStates(files, applied);
    if (states.some((state) => state.status === "CHECKSUM_MISMATCH")) fail("CHECKSUM_MISMATCH", "An applied migration differs from the local version. Nothing was migrated.");
    for (const file of files) {
      if (states.find((state) => state.name === file.name)?.status === "APPLIED_MATCH") continue;
      await client.query(file.sql);
      await client.query("insert into public.makeready_schema_migrations(name,sha256) values($1,$2)", [file.name, file.sha256]);
    }
    await client.query("notify pgrst, 'reload schema'");
    await client.query("commit");
    return states.map((state) => ({ name: state.name, action: state.status === "APPLIED_MATCH" ? "SKIPPED_MATCHING" : "APPLIED" }));
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
}

async function upsertVault(client: Client, name: string, value: string, description: string) {
  const current = (await client.query<{ id: string }>("select id::text from vault.secrets where name=$1", [name])).rows;
  if (current.length > 1) fail("DUPLICATE_VAULT_SECRET", "A reconciliation Vault name has multiple records; resolve that ambiguity before scheduling.");
  if (current.length) await client.query("select vault.update_secret($1::uuid,$2::text,$3::text,$4::text)", [current[0].id, value, name, description]);
  else await client.query("select vault.create_secret($1::text,$2::text,$3::text)", [value, name, description]);
}

async function applyCron(client: Client, scheduleSql: string, origin: string, secret: string) {
  await beginSetup(client);
  try {
    await client.query("create extension if not exists supabase_vault with schema vault");
    await upsertVault(client, "makeready_app_url", origin, "Dedicated MakeReady stable preview HTTPS origin");
    await upsertVault(client, "makeready_executor_secret", secret, "Dedicated MakeReady background executor credential");
    await client.query(scheduleSql);
    const check = (await client.query<{ matches: boolean }>(`select
      (select count(*)=1 from vault.secrets where name='makeready_app_url')
      and (select count(*)=1 from vault.secrets where name='makeready_executor_secret')
      and (select decrypted_secret=$1 from vault.decrypted_secrets where name='makeready_app_url')
      and (select decrypted_secret=$2 from vault.decrypted_secrets where name='makeready_executor_secret') as matches`, [origin, secret])).rows[0];
    if (check.matches !== true) fail("VAULT_VERIFICATION_FAILED", "Named reconciliation Vault secrets did not match the intended configuration.");
    await client.query("commit");
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
}

export async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
  const target = validateTarget(process.env);
  const ca = verifiedCertificate(await readFile(join(root, "supabase/certs/supabase-root-2021.pem"), "utf8"));
  const files = await loadMigrations();
  const scheduleSql = await readFile(join(root, "supabase/setup-reconciliation.sql"), "utf8");
  cronCommand(scheduleSql);
  const origin = flags.cron ? cronOrigin(process.env) : undefined;
  const secret = flags.cron ? process.env.EXECUTOR_SECRET : undefined;
  if (flags.cron && (!secret || secret.length < 32)) fail("MISSING_EXECUTOR_SECRET", "Cron setup requires EXECUTOR_SECRET with at least 32 characters.");
  const client = new pg.Client(connectionConfig(target, ca));
  // Do not let an asynchronous driver error print raw connection information.
  client.on("error", () => {});
  try {
    await client.connect();
    const before = await inspect(client, files, scheduleSql);
    if (before.migrations.some((migration) => migration.status === "CHECKSUM_MISMATCH")) fail("CHECKSUM_MISMATCH", "An applied migration differs from the local version; refusing setup writes.");
    if (!flags.apply) { console.info(JSON.stringify({ mode: "READ_ONLY", ...before }, null, 2)); return; }
    if (flags.cron && !flags.migrate && before.migrations.some((migration) => migration.status !== "APPLIED_MATCH")) fail("MISSING_SCHEMA", "Apply and verify the versioned schema before configuring reconciliation.");
    const migrationActions = flags.migrate ? await applyMigrations(client, files) : [];
    if (flags.cron) await applyCron(client, scheduleSql, origin!, secret!);
    const after = await inspect(client, files, scheduleSql);
    if (flags.cron && (after.cron.length !== 1 || after.cron[0].schedule !== "* * * * *" || !after.cron[0].active || !after.cron[0].commandMatches)) {
      fail("CRON_VERIFICATION_FAILED", "Cron was configured but its active schedule could not be verified. Inspect before retrying setup.");
    }
    console.info(JSON.stringify({ mode: "APPLIED", migrationActions, reconciliation: flags.cron ? "CONFIGURED_EVERY_MINUTE" : "NOT_REQUESTED", ...after }, null, 2));
  } finally { await client.end().catch(() => {}); }
}

const directlyInvoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directlyInvoked) main().catch((error: unknown) => {
  if (error instanceof SetupError) console.error(`database_setup: ${error.code} ${error.message}`);
  else {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code) ? ` code=${error.code}` : "";
    console.error(`database_setup: FAILED${code} (details suppressed; no credentials or raw database messages are logged)`);
  }
  process.exitCode = 1;
});
