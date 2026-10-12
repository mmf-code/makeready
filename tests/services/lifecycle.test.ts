import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRef, Revision, RevisionPlan } from "@/lib/contracts";
import type { IntelligenceResponseMetadata } from "@/lib/providers/openai";

const mock = vi.hoisted(() => ({ getDb: vi.fn(), rpc: vi.fn(), intelligence: vi.fn(), plan: vi.fn() }));
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("@/lib/db")>(), getDb: mock.getDb, rpc: mock.rpc }));
vi.mock("@/lib/providers", async (original) => ({ ...await original<typeof import("@/lib/providers")>(), createDesignIntelligence: mock.intelligence }));
import { createServices } from "@/lib/services";
import { AppError, databaseError } from "@/lib/errors";
import { ProviderError } from "@/lib/providers/types";
import { hashBytes, readArtifact, storeArtifact } from "@/lib/storage";
import { evaluateRevision } from "@/lib/harness/evaluate";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };
const rpcParameters: Record<string, string[]> = {
  mr_create_job: ["p_scope","p_job","p_payload","p_key","p_input_hash","p_reserve_micros","p_cap_micros"],
  mr_claim_job: ["p_id","p_owner"], mr_patch_job: ["p_id","p_fence","p_patch","p_payload","p_provider_ref"],
  mr_release_job: ["p_id","p_fence"], mr_finish_job: ["p_id","p_fence","p_record","p_kind"],
  mr_fail_job: ["p_id","p_fence","p_error","p_unknown"],
};
const timestamp = "2026-10-12T08:00:00.000Z";
const spec = { description: "A friendly fox", objectType: "fox", use: "Figurine", targetHeightMm: 120, preserve: ["face"], changeable: ["ears"], process: "resin_candidate" as const };
const draft = { requestedChange: "Smaller ears", interpretedIntent: "Reduce ear proportions", preserve: ["face"], action: "edit_concept" as const, reason: "User request", expectedDifferences: ["Smaller ears"], targetHeightMm: null };

describe("application lifecycle against the actual migration", () => {
  let db: PGlite;
  let image: Uint8Array;
  const files = new Map<string, Uint8Array>();
  const scope = "service-lifecycle";

  // Translate only the Supabase fluent operations used by the actual services.
  // No jobs, budget logic, record validation or lease logic are mocked.
  function from(table: string) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid test table");
    let fields = "*", mode: "select" | "insert" | "update" = "select";
    let inserts: Row[] = [], changes: Row = {}, returning = false, ordering = "";
    const filters: [string, unknown][] = [];
    let executed: Promise<Result> | undefined;
    const identifier = (value: string) => { if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid test column"); return `"${value}"`; };
    const projection = () => fields === "*" ? "*" : fields.split(",").map(identifier).join(",");
    async function run(): Promise<Result> {
      const values: unknown[] = [];
      const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
      let sql = "";
      if (mode === "insert") {
        const columns = Object.keys(inserts[0]);
        sql = `insert into public.${identifier(table)} (${columns.map(identifier).join(",")}) values ${inserts.map(row => `(${columns.map(key => bind(row[key])).join(",")})`).join(",")}`;
      } else if (mode === "update") {
        sql = `update public.${identifier(table)} set ${Object.entries(changes).map(([key,value]) => `${identifier(key)}=${bind(value)}`).join(",")}`;
      } else sql = `select ${projection()} from public.${identifier(table)}`;
      if (filters.length) sql += ` where ${filters.map(([key,value]) => `${identifier(key)}=${bind(value)}`).join(" and ")}`;
      if (mode === "select") sql += ordering;
      else if (returning) sql += ` returning ${projection()}`;
      try {
        const result = await db.query(sql, values);
        // PostgREST transports timestamps as JSON strings, while PGlite returns Date.
        return { data: mode !== "select" && !returning ? null : JSON.parse(JSON.stringify(result.rows)) as Row[], error: null };
      } catch (error) {
        const failure = error as { code?: string; message: string };
        return { data: null, error: { code: failure.code, message: failure.message } };
      }
    }
    const execute = () => executed ??= run();
    const chain = {
      select(value = "*") { fields = value; returning = mode !== "select"; return chain; },
      eq(key: string, value: unknown) { filters.push([key,value]); return chain; },
      insert(value: Row | Row[]) { mode = "insert"; inserts = Array.isArray(value) ? value : [value]; return chain; },
      update(value: Row) { mode = "update"; changes = value; return chain; },
      order(key: string, options: { ascending?: boolean } = {}) { ordering = ` order by ${identifier(key)} ${options.ascending === false ? "desc" : "asc"}`; return chain; },
      async maybeSingle() { const result = await execute(); return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }; },
      async single() { return chain.maybeSingle(); },
      then(resolve: (value: Result) => unknown, reject?: (error: unknown) => unknown) { return execute().then(resolve,reject); },
    };
    return chain;
  }
  async function rpc(name: string, args: Row) {
    const keys = rpcParameters[name]; if (!keys) throw new Error("Unexpected RPC");
    // Omit trailing optional arguments so PostgreSQL uses its real defaults.
    const last = keys.findLastIndex(key => key in args);
    const values = keys.slice(0,last+1).map(key => args[key] ?? null);
    try { return (await db.query<{ result: unknown }>(`select public.${name}(${values.map((_,index) => `$${index+1}`).join(",")}) as result`,values)).rows[0].result; }
    catch (error) { databaseError(error as { message: string }); }
  }
  const storage = {
    from: () => ({
      async upload(path: string, bytes: Uint8Array) {
        if (files.has(path)) return { data: null, error: { message: "Object already exists" } };
        files.set(path, new Uint8Array(bytes)); return { data: { path }, error: null };
      },
      async download(path: string) {
        const bytes = files.get(path);
        return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: "Object not found" } };
      },
      async createSignedUrl(path: string) { return { data: { signedUrl: `https://storage.example.test/${path}?signed=test` }, error: null }; },
    }),
  };

  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);");
    await db.exec(await readFile(new URL("../../supabase/migrations/202610120001_makeready.sql", import.meta.url),"utf8"));
    image = await sharp({ create: { width: 12, height: 10, channels: 3, background: "orange" } }).png().toBuffer();
  }, 30_000);
  beforeEach(async () => {
    await db.exec("truncate public.generation_job_events,public.design_records,public.make_artifacts,public.generation_jobs,public.make_budgets,public.design_sessions restart identity cascade;");
    files.clear(); vi.clearAllMocks();
    vi.stubEnv("FAL_KEY","test-only"); vi.stubEnv("OPENAI_API_KEY","test-only"); vi.stubEnv("LLM_BASE_URL",""); vi.stubEnv("MAKE_BUDGET_USD","50");
    for (const key of ["LLM_API_KEY", "ANTHROPIC_API_KEY", "LLM_API_STYLE", "LLM_MODEL"]) vi.stubEnv(key, "");
    mock.getDb.mockReturnValue({ from, storage }); mock.rpc.mockImplementation(rpc);
    mock.intelligence.mockImplementation((options: { onResponse?: (metadata: IntelligenceResponseMetadata) => Promise<void> }) => ({ planRevision: (input: unknown) => mock.plan(input,options.onResponse) }));
    mock.plan.mockImplementation(async (_input: unknown, onResponse?: (metadata: IntelligenceResponseMetadata) => Promise<void>) => {
      await onResponse?.({ operation: "revision_plan", responseId: "received-response", requestId: "request-id", model: "test-model", inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20 });
      return draft;
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db.close(); });

  async function rows<T extends Row = Row>(sql: string, values: unknown[] = []) { return (await db.query<T>(sql,values)).rows; }
  async function parent(kind: Revision["kind"] = "concept") {
    const session = await createServices(scope).createSession({ title: "Actual stored test input" });
    const artifacts: ArtifactRef[] = kind === "concept" ? [await storeArtifact(session.id,"concept_image",image,"image/png","png")] : await Promise.all([
      storeArtifact(session.id,"source_glb",new Uint8Array([1,2,3]),"model/gltf-binary","glb","m","y_up"),
      storeArtifact(session.id,"model_glb",new Uint8Array([4,5,6]),"model/gltf-binary","glb","m","y_up"),
      storeArtifact(session.id,"model_stl",new Uint8Array([7,8,9]),"model/stl","stl","mm","z_up"),
      storeArtifact(session.id,"audit",new TextEncoder().encode("{}"),"application/json","json"),
    ]);
    // Synthetic geometry bytes are explicitly a service fixture, never a UI/demo result.
    const revision: Revision = { id: randomUUID(), sessionId: session.id, parentRevisionId: null, kind, spec, artifacts, sourceJobId: null, createdAt: timestamp };
    await db.query("insert into public.design_records(id,session_id,kind,data) values($1,$2,'revision',$3)",[revision.id,session.id,revision]);
    return revision;
  }
  async function savePlan(revision: Revision, action: RevisionPlan["action"] = "edit_concept") {
    const plan: RevisionPlan = { ...draft, id: randomUUID(), sessionId: revision.sessionId, parentRevisionId: revision.id, action, targetHeightMm: action === "scale_geometry" ? 60 : null, maxAttempts: 2, estimatedCostUsd: action === "scale_geometry" ? 0 : .5, createdAt: timestamp };
    await db.query("insert into public.design_records(id,session_id,kind,data) values($1,$2,'plan',$3)",[plan.id,plan.sessionId,plan]); return plan;
  }
  const initialInput = () => ({ prompt: "A small fox", confirmCost: true as const, idempotencyKey: randomUUID(), heightMm: 120, use: "Figurine" });

  it("deduplicates concurrent first submissions into one session, job and budget reservation", async () => {
    const input = initialInput(), services = createServices(scope);
    const [first,second] = await Promise.all([services.startDesign(input),services.startDesign(input)]);
    expect(first).toEqual(second);
    expect(await rows("select count(*)::int as count from public.design_sessions")).toEqual([{ count: 1 }]);
    expect(await rows("select count(*)::int as count from public.generation_jobs")).toEqual([{ count: 1 }]);
    expect(await rows("select reserved_micros::int as reserved from public.make_budgets")).toEqual([{ reserved: 500_000 }]);
    expect(mock.intelligence).not.toHaveBeenCalled();
    await expect(services.startDesign({ ...input, prompt: "A different fox" })).rejects.toMatchObject({ code: "CONFLICT" });
    vi.stubEnv("FAL_KEY",""); vi.stubEnv("OPENAI_API_KEY","");
    expect(await services.startDesign(input)).toEqual(first);
  });

  it("deduplicates actual attachment bytes into one stable session/job without LLM access", async () => {
    const services = createServices(scope), input = initialInput();
    const attachment = { bytes: image, sha256: hashBytes(image), mimeType: "image/png" as const, fileName: "original.png" };
    vi.stubEnv("FAL_KEY",""); vi.stubEnv("OPENAI_API_KEY",""); vi.stubEnv("LLM_API_KEY","");
    const [first,second] = await Promise.all([
      services.startPhotoDesign(input,attachment),
      services.startPhotoDesign(input,{ ...attachment, fileName: "same-content-renamed.png" }),
    ]);
    expect(first).toEqual(second);
    expect(first.job).toMatchObject({ sessionId: first.sessionId, operation: "concept", provider: "local", estimatedCostUsd: 0 });
    expect(await rows("select count(*)::int as count from public.design_sessions")).toEqual([{ count: 1 }]);
    expect(await rows("select count(*)::int as count from public.generation_jobs")).toEqual([{ count: 1 }]);
    expect(await rows("select reserved_micros::int as reserved,spent_micros::int as spent from public.make_budgets")).toEqual([{ reserved: 0, spent: 0 }]);
    const saved = (await rows<{ payload: { sourceImage: ArtifactRef } }>("select payload from public.generation_jobs where id=$1",[first.job.id]))[0].payload.sourceImage;
    expect(saved).toMatchObject({ sessionId: first.sessionId, kind: "source_image", sha256: attachment.sha256, sizeBytes: image.length, mimeType: "image/png" });
    expect((await rows<{ data: ArtifactRef; verified: boolean }>("select data,verified from public.make_artifacts where id=$1",[saved.id]))[0]).toEqual({ data: saved, verified: true });
    expect(await readArtifact(saved)).toEqual(new Uint8Array(image));
    const storedCount = files.size;
    expect(await services.startPhotoDesign(input,{ ...attachment, fileName: "third-name.png" })).toEqual(first);
    expect(files.size).toBe(storedCount);
    expect(mock.intelligence).not.toHaveBeenCalled(); expect(mock.plan).not.toHaveBeenCalled();
  });

  it("rejects changed attachment content under the same key and invalid byte receipts", async () => {
    const services = createServices(scope), input = initialInput();
    const attachment = { bytes: image, sha256: hashBytes(image), mimeType: "image/png" as const };
    await services.startPhotoDesign(input,attachment);
    const changed = await sharp({ create: { width: 12, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
    await expect(services.startPhotoDesign(input,{ ...attachment, bytes: changed, sha256: hashBytes(changed) })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await expect(services.startPhotoDesign(input,{ ...attachment, bytes: changed })).rejects.toMatchObject({ code: "INVALID_ARTIFACT", status: 422 });
    expect(await rows("select count(*)::int as count from public.generation_jobs")).toEqual([{ count: 1 }]);
    expect(await rows("select count(*)::int as count from public.make_artifacts")).toEqual([{ count: 1 }]);
    expect(mock.intelligence).not.toHaveBeenCalled();
  });

  it("rejects foreign-session IDs and records before creating a new job or decision", async () => {
    const revision = await parent(), foreign = createServices("foreign-scope");
    await expect(foreign.getSession(revision.sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(foreign.decideRevision({ revisionId: revision.id, decision: "approve" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(foreign.startDesign({ ...initialInput(), sessionId: revision.sessionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await rows("select count(*)::int as count from public.generation_jobs")).toEqual([{ count: 0 }]);
    expect(await rows("select count(*)::int as count from public.design_records where kind='decision'")).toEqual([{ count: 0 }]);
  });

  it("accepts an actual photo without LLM billing, then permits human-approved fal modeling", async () => {
    const services = createServices(scope), session = await services.createSession({ title: "Photo upload" });
    const photo = await storeArtifact(session.id,"source_image",image,"image/png","png");
    vi.stubEnv("FAL_KEY",""); vi.stubEnv("OPENAI_API_KEY",""); vi.stubEnv("LLM_API_KEY","");
    const started = await services.startDesign({ ...initialInput(), sessionId: session.id, imageArtifactId: photo.id });
    expect(started.job).toMatchObject({ provider: "local", estimatedCostUsd: 0, operation: "concept" });
    const lease = await rpc("mr_claim_job",{ p_id: started.job.id, p_owner: randomUUID() }) as { fence: number };
    const revision: Revision = { id: randomUUID(), sessionId: session.id, parentRevisionId: null, kind: "concept", spec, artifacts: [photo], sourceJobId: started.job.id, createdAt: timestamp };
    await rpc("mr_finish_job",{ p_id: started.job.id, p_fence: lease.fence, p_record: revision, p_kind: "revision" });
    await services.decideRevision({ revisionId: revision.id, decision: "approve" });
    vi.stubEnv("FAL_KEY","test-only");
    const model = await services.generateModel({ revisionId: revision.id, confirmCost: true, idempotencyKey: randomUUID() });
    expect(model).toMatchObject({ operation: "model", provider: "fal", parentRevisionId: revision.id });
    expect(mock.intelligence).not.toHaveBeenCalled();
    expect(await rows("select reserved_micros::int as reserved,spent_micros::int as spent from public.make_budgets")).toEqual([{ reserved: 5_000_000, spent: 0 }]);
  });

  it("rejects a parent, executes the saved plan, and preserves separate comparable revisions", async () => {
    const revision = await parent(), services = createServices(scope);
    const before = structuredClone(revision);
    await services.decideRevision({ revisionId: revision.id, decision: "reject", note: "Smaller ears, preserve face" });
    const plan = await services.planRevision({ sessionId: revision.sessionId, revisionId: revision.id, feedback: "Smaller ears", confirmCost: true, idempotencyKey: randomUUID() });
    const execution = await services.executePlan({ planId: plan.id, confirmCost: true, idempotencyKey: randomUUID() });
    const saved = (await rows<{ payload: Row }>("select payload from public.generation_jobs where id=$1",[execution.id]))[0].payload;
    expect(saved.plan).toEqual(plan); expect(saved.parent).toEqual(before); expect(execution.parentRevisionId).toBe(revision.id);
    const lease = await rpc("mr_claim_job",{ p_id: execution.id, p_owner: randomUUID() }) as { fence: number };
    const editedImage = await sharp({ create: { width: 12, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
    const artifact = await storeArtifact(revision.sessionId,"concept_image",editedImage,"image/png","png");
    const child: Revision = { ...revision, id: randomUUID(), parentRevisionId: revision.id, artifacts: [artifact], sourceJobId: execution.id };
    await rpc("mr_finish_job",{ p_id: execution.id, p_fence: lease.fence, p_record: child, p_kind: "revision" });
    await evaluateRevision(child,plan); await evaluateRevision(child,plan);
    const timeline = await services.getSession(revision.sessionId);
    expect((await rows<{ data: Revision }>("select data from public.design_records where id=$1",[revision.id]))[0].data).toEqual(before);
    expect(timeline.revisions).toHaveLength(2); expect(timeline.decisions[0].decision).toBe("reject");
    expect(timeline.evaluations.filter(value => value.revisionId === revision.id && value.kind === "human")).toHaveLength(1);
    expect(timeline.comparisons).toHaveLength(1); expect(timeline.comparisons[0]).toMatchObject({ parentRevisionId: revision.id, childRevisionId: child.id, planId: plan.id });
    await expect(services.generateModel({ revisionId: child.id, confirmCost: true, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await services.decideRevision({ revisionId: child.id, decision: "approve" });
    expect((await services.generateModel({ revisionId: child.id, confirmCost: true, idempotencyKey: randomUUID() })).parentRevisionId).toBe(child.id);
  });

  it("stores the selected Claude model and receipt on a durable planning job", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unused-openai-key");
    vi.stubEnv("LLM_API_KEY", "sk-ant-test-only");
    vi.stubEnv("LLM_API_STYLE", "anthropic");
    vi.stubEnv("LLM_MODEL", "claude-haiku-5-5");
    vi.stubEnv("LLM_BASE_URL", "https://api.anthropic.com/v1");
    mock.plan.mockImplementation(async (_input: unknown, onResponse?: (metadata: IntelligenceResponseMetadata) => Promise<void>) => {
      await onResponse?.({ operation: "revision_plan", responseId: "msg_test", requestId: "request-test", model: "claude-haiku-5-5", inputTokens: 40, cachedInputTokens: 10, outputTokens: 30, totalTokens: 70 });
      return draft;
    });
    const revision = await parent(), services = createServices(scope);
    const input = { sessionId: revision.sessionId, revisionId: revision.id, feedback: "Smaller ears", confirmCost: true as const, idempotencyKey: randomUUID() };
    const plan = await services.planRevision(input);
    const saved = (await rows<{ data: { provider: string | null; providerRequestId: string; status: string }; payload: { intelligenceReceipt: IntelligenceResponseMetadata } }>("select data,payload from public.generation_jobs where data->>'operation'='planning'"))[0];
    expect(saved.data).toMatchObject({ provider: null, providerRequestId: "msg_test", status: "completed" });
    expect(saved.payload.intelligenceReceipt).toMatchObject({ model: "claude-haiku-5-5", responseId: "msg_test", requestId: "request-test", inputTokens: 40, totalTokens: 70 });
    expect(await services.planRevision(input)).toEqual(plan);
    expect(mock.plan).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(saved)).not.toContain("sk-ant-test-only");
  });

  it("reuses a completed planning job without calling intelligence or charging again", async () => {
    const revision = await parent(), services = createServices(scope);
    const input = { sessionId: revision.sessionId, revisionId: revision.id, feedback: "Smaller ears", confirmCost: true as const, idempotencyKey: randomUUID() };
    const plan = await services.planRevision(input);
    const before = await rows("select reserved_micros::int,spent_micros::int from public.make_budgets");
    vi.stubEnv("OPENAI_API_KEY","");
    expect(await services.planRevision(input)).toEqual(plan);
    expect(mock.plan).toHaveBeenCalledTimes(1); expect(await rows("select reserved_micros::int,spent_micros::int from public.make_budgets")).toEqual(before);
    await expect(services.planRevision({ ...input, feedback: "Bigger ears" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("scales stored manufacturing geometry without an image or provider credentials", async () => {
    const revision = await parent("manufacturing"), plan = await savePlan(revision,"scale_geometry");
    vi.stubEnv("FAL_KEY",""); vi.stubEnv("OPENAI_API_KEY","");
    const execution = await createServices(scope).executePlan({ planId: plan.id, confirmCost: true, idempotencyKey: randomUUID() });
    expect(execution).toMatchObject({ operation: "scale", provider: "local", estimatedCostUsd: 0, parentRevisionId: revision.id, planId: plan.id });
    const payload = (await rows<{ payload: Row }>("select payload from public.generation_jobs where id=$1",[execution.id]))[0].payload;
    expect(payload).not.toHaveProperty("sourceImage"); expect(mock.plan).not.toHaveBeenCalled();
  });

  it("recovers a checkpointed plan after transient finalization without another paid call", async () => {
    const revision = await parent(), services = createServices(scope);
    const input = { sessionId: revision.sessionId, revisionId: revision.id, feedback: "Smaller ears", confirmCost: true as const, idempotencyKey: randomUUID() };
    mock.rpc.mockImplementationOnce(rpc); // enqueue remains the real RPC.
    const original = mock.rpc.getMockImplementation()!;
    let failFinish = true;
    mock.rpc.mockImplementation(async (name: string,args: Row) => {
      if (name === "mr_finish_job" && failFinish) { failFinish = false; throw new AppError("STORAGE_FAILED","temporary outage",503,true); }
      return original(name,args);
    });
    await expect(services.planRevision(input)).rejects.toMatchObject({ code: "STORAGE_FAILED", retryable: true });
    expect((await rows("select data->>'status' as status,payload->>'dispatchInFlight' as dispatch from public.generation_jobs"))[0]).toEqual({ status: "verifying", dispatch: "false" });
    const plan = await services.planRevision(input); expect(plan.parentRevisionId).toBe(revision.id); expect(mock.plan).toHaveBeenCalledTimes(1);
    expect(await rows("select reserved_micros::int as reserved,spent_micros::int as spent from public.make_budgets")).toEqual([{ reserved: 0, spent: 100_000 }]);
  });

  it("quarantines an interrupted planning dispatch on the first recovery response", async () => {
    const revision = await parent(), services = createServices(scope);
    const input = { sessionId: revision.sessionId, revisionId: revision.id, feedback: "Smaller ears", confirmCost: true as const, idempotencyKey: randomUUID() };
    mock.plan.mockRejectedValueOnce(new ProviderError("connection lost","transport"));
    await expect(services.planRevision(input)).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    await expect(services.planRevision(input)).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(mock.plan).toHaveBeenCalledTimes(1);
    const saved = (await rows<{ id: string }>("select id from public.generation_jobs"))[0];
    // Simulate a crash instead of the catch branch: status active, durable in-flight bit.
    await db.query("update public.generation_jobs set data=jsonb_set(data,'{status}','\"planning\"'),lease_owner=null,lease_until=null where id=$1",[saved.id]);
    await expect(services.planRevision(input)).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(mock.plan).toHaveBeenCalledTimes(1);
    expect(await rows("select reserved_micros::int as reserved,spent_micros::int as spent from public.make_budgets")).toEqual([{ reserved: 100_000, spent: 0 }]);
  });
});
