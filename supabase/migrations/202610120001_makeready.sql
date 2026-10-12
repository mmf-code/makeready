-- Dedicated MakeReady project only. No CrafThinkERA/EVRE tables or data.
create table public.design_sessions (
  id uuid primary key, scope text not null check(length(scope) > 0), data jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,scope), check(jsonb_typeof(data) = 'object' and (data->>'id') is not distinct from id::text)
);
create table public.make_budgets (
  scope text primary key, cap_micros bigint not null check(cap_micros > 0),
  reserved_micros bigint not null default 0 check(reserved_micros >= 0),
  spent_micros bigint not null default 0 check(spent_micros >= 0),
  check(reserved_micros + spent_micros <= cap_micros)
);
create table public.generation_jobs (
  id uuid primary key, session_id uuid not null, scope text not null references public.make_budgets(scope),
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'), data jsonb not null, payload jsonb not null,
  provider_ref jsonb, reserve_micros bigint not null default 0 check(reserve_micros >= 0), settled boolean not null default false,
  lease_owner uuid, lease_until timestamptz, fence bigint not null default 0 check(fence >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(session_id,scope) references public.design_sessions(id,scope), unique(scope,idempotency_key),
  check((lease_owner is null) = (lease_until is null)),
  check(jsonb_typeof(data) = 'object' and jsonb_typeof(payload) = 'object'),
  check((data->>'id') is not distinct from id::text and (data->>'sessionId') is not distinct from session_id::text),
  check(coalesce(data->>'operation' in ('concept','refinement','model','planning','scale','import'),false)),
  check(coalesce(data->>'status' in ('created','planning','submitting','submission_unknown','queued','running','ingesting','preparing','verifying','completed','failed'),false))
);
create table public.design_records (
  id uuid primary key, session_id uuid not null references public.design_sessions(id),
  kind text not null check(kind in ('revision','plan','evaluation','comparison','decision')),
  data jsonb not null, source_job_id uuid references public.generation_jobs(id), created_at timestamptz not null default now(),
  check(jsonb_typeof(data) = 'object'),
  check((data->>'id') is not distinct from id::text and (data->>'sessionId') is not distinct from session_id::text)
);
-- A job has one primary result. Physical and visual observations are separate records.
create unique index design_records_primary_job on public.design_records(source_job_id) where kind in ('revision','plan');
create unique index design_records_evaluation_job on public.design_records(source_job_id,(data->>'kind')) where kind = 'evaluation';
create index design_records_session on public.design_records(session_id,created_at);
create index generation_jobs_reconcile on public.generation_jobs(lease_until,created_at) where data->>'status' not in ('completed','failed','submission_unknown');
create table public.make_artifacts (
  id uuid primary key, session_id uuid not null references public.design_sessions(id),
  data jsonb not null, verified boolean not null default false, created_at timestamptz not null default now(),
  check(jsonb_typeof(data) = 'object'),
  check((data->>'id') is not distinct from id::text and (data->>'sessionId') is not distinct from session_id::text),
  check(not (data ? 'url') and not (data ? 'expiresAt')),
  check(coalesce(data->>'sha256' ~ '^[a-f0-9]{64}$',false)),
  check(coalesce(jsonb_typeof(data->'sizeBytes') = 'number' and (data->>'sizeBytes')::numeric between 1 and 52428800 and trunc((data->>'sizeBytes')::numeric) = (data->>'sizeBytes')::numeric,false)),
  check(coalesce(data->>'storagePath' ~ ('^'||session_id::text||'/'||id::text||'/'||(data->>'sha256')||'\.[a-z0-9]{1,10}$'),false)),
  check(coalesce(case data->>'kind'
    when 'source_glb' then data->>'mimeType' = 'model/gltf-binary' and data->>'units' = 'm' and data->>'axis' = 'y_up'
    when 'model_glb' then data->>'mimeType' = 'model/gltf-binary' and data->>'units' = 'm' and data->>'axis' = 'y_up'
    when 'model_stl' then data->>'mimeType' = 'model/stl' and data->>'units' = 'mm' and data->>'axis' = 'z_up'
    when 'source_image' then data->>'mimeType' in ('image/png','image/jpeg','image/webp') and data->>'units' = 'none' and data->>'axis' = 'none'
    when 'concept_image' then data->>'mimeType' in ('image/png','image/jpeg','image/webp') and data->>'units' = 'none' and data->>'axis' = 'none'
    when 'audit' then data->>'mimeType' = 'application/json' and data->>'units' = 'none' and data->>'axis' = 'none'
    when 'manifest' then data->>'mimeType' = 'application/json' and data->>'units' = 'none' and data->>'axis' = 'none'
    when 'make_package' then data->>'mimeType' = 'application/zip' and data->>'units' = 'none' and data->>'axis' = 'none'
    else false end,false))
);
-- PostgreSQL expression uniqueness is an index, not a table UNIQUE constraint.
create unique index make_artifacts_storage_path on public.make_artifacts((data->>'storagePath'));
create table public.generation_job_events (
  id bigint generated always as identity primary key, job_id uuid not null references public.generation_jobs(id),
  kind text not null, data jsonb not null default '{}', created_at timestamptz not null default now()
);

create function public.mr_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'IMMUTABLE_RECORD'; end $$;
create trigger immutable_design_records before update or delete on public.design_records for each row execute function public.mr_immutable();
create trigger immutable_job_events before update or delete on public.generation_job_events for each row execute function public.mr_immutable();
create function public.mr_verified_artifact_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.verified then raise exception 'IMMUTABLE_ARTIFACT'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.id is distinct from old.id or new.session_id is distinct from old.session_id or new.data is distinct from old.data then raise exception 'IMMUTABLE_ARTIFACT_METADATA'; end if;
  return new;
end $$;
create trigger immutable_verified_artifacts before update or delete on public.make_artifacts for each row execute function public.mr_verified_artifact_immutable();

-- Runs for RPC finalization and direct append-only observations alike.
create function public.mr_validate_record() returns trigger language plpgsql set search_path = '' as $$
declare r public.design_records; j public.generation_jobs; a jsonb; e jsonb; expected_hashes jsonb; actual_hashes jsonb; kinds text[];
begin
  if new.source_job_id is not null then
    select * into j from public.generation_jobs where id = new.source_job_id and session_id = new.session_id;
    if not found then raise exception 'SESSION_MISMATCH'; end if;
  end if;
  if new.kind in ('revision','plan') then
    if new.data->>'parentRevisionId' is not null then
      select * into r from public.design_records where id = (new.data->>'parentRevisionId')::uuid and session_id = new.session_id and kind = 'revision';
      if not found then raise exception 'PARENT_NOT_FOUND'; end if;
    elsif new.kind = 'plan' then raise exception 'PARENT_NOT_FOUND'; end if;
    if new.source_job_id is not null and (new.data->>'parentRevisionId') is distinct from (j.data->>'parentRevisionId') then raise exception 'LINEAGE_MISMATCH'; end if;
  end if;
  if new.kind = 'revision' then
    if (new.data->>'sourceJobId') is distinct from new.source_job_id::text then raise exception 'SOURCE_JOB_MISMATCH'; end if;
    if jsonb_typeof(new.data->'artifacts') is distinct from 'array' then raise exception 'ARTIFACTS_REQUIRED'; end if;
    if jsonb_array_length(new.data->'artifacts') = 0 then raise exception 'ARTIFACTS_REQUIRED'; end if;
    for a in select value from jsonb_array_elements(new.data->'artifacts') loop
      -- Whole canonical receipt must match, including path, kind, units and axis.
      if not exists(select 1 from public.make_artifacts where id = (a->>'id')::uuid and session_id = new.session_id and verified and data = a) then raise exception 'ARTIFACT_NOT_VERIFIED'; end if;
    end loop;
    if (select count(*) from jsonb_array_elements(new.data->'artifacts')) <> (select count(distinct value->>'id') from jsonb_array_elements(new.data->'artifacts')) then raise exception 'DUPLICATE_ARTIFACT'; end if;
    select array_agg(value->>'kind') into kinds from jsonb_array_elements(new.data->'artifacts');
    if new.data->>'kind' = 'manufacturing' then
      if not (kinds @> array['source_glb','model_glb','model_stl','audit']) then raise exception 'ARTIFACTS_REQUIRED'; end if;
    elsif new.data->>'kind' = 'concept' then
      if not (kinds && array['source_image','concept_image']) then raise exception 'ARTIFACTS_REQUIRED'; end if;
    else raise exception 'INVALID_RECORD_KIND'; end if;
  elsif new.kind = 'plan' then
    if new.data->>'maxAttempts' is distinct from '2' then raise exception 'INVALID_ATTEMPT_LIMIT'; end if;
  elsif new.kind in ('evaluation','decision') then
    select * into r from public.design_records where id = (new.data->>'revisionId')::uuid and session_id = new.session_id and kind = 'revision';
    if not found then raise exception 'REVISION_NOT_FOUND'; end if;
    if jsonb_typeof(new.data->'artifactHashes') is distinct from 'array' then raise exception 'ARTIFACT_HASH_MISMATCH'; end if;
    select coalesce(jsonb_agg(value->'sha256' order by value->>'sha256'),'[]'::jsonb) into expected_hashes from jsonb_array_elements(r.data->'artifacts');
    select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into actual_hashes from jsonb_array_elements(new.data->'artifactHashes');
    if expected_hashes is distinct from actual_hashes then raise exception 'ARTIFACT_HASH_MISMATCH'; end if;
  elsif new.kind = 'comparison' then
    if not exists(select 1 from public.design_records where id = (new.data->>'parentRevisionId')::uuid and session_id = new.session_id and kind = 'revision') then raise exception 'PARENT_NOT_FOUND'; end if;
    if not exists(select 1 from public.design_records where id = (new.data->>'childRevisionId')::uuid and session_id = new.session_id and kind = 'revision' and data->>'parentRevisionId' = new.data->>'parentRevisionId') then raise exception 'LINEAGE_MISMATCH'; end if;
    if new.data->>'planId' is not null and not exists(select 1 from public.design_records where id = (new.data->>'planId')::uuid and session_id = new.session_id and kind = 'plan' and data->>'parentRevisionId' = new.data->>'parentRevisionId') then raise exception 'PLAN_NOT_FOUND'; end if;
    if jsonb_typeof(new.data->'visualEvaluationIds') is distinct from 'array' or jsonb_typeof(new.data->'physicalEvaluationIds') is distinct from 'array' then raise exception 'EVALUATION_NOT_FOUND'; end if;
    for e in select jsonb_build_object('id',value,'kind','visual') from jsonb_array_elements(new.data->'visualEvaluationIds') union all select jsonb_build_object('id',value,'kind','physical') from jsonb_array_elements(new.data->'physicalEvaluationIds') loop
      if not exists(select 1 from public.design_records where id = (e->>'id')::uuid and session_id = new.session_id and kind = 'evaluation' and data->>'kind' = e->>'kind' and data->>'revisionId' in (new.data->>'parentRevisionId',new.data->>'childRevisionId')) then raise exception 'EVALUATION_NOT_FOUND'; end if;
    end loop;
  end if;
  return new;
end $$;
create trigger validate_design_record before insert on public.design_records for each row execute function public.mr_validate_record();

create function public.mr_create_job(p_scope text,p_job jsonb,p_payload jsonb,p_key text,p_input_hash text,p_reserve_micros bigint,p_cap_micros bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.generation_jobs; b public.make_budgets; plan public.design_records;
begin
  if p_scope is null or length(p_scope) = 0 or p_reserve_micros is null or p_reserve_micros < 0 or p_cap_micros is null or p_cap_micros <= 0 then raise exception 'INVALID_BUDGET'; end if;
  if jsonb_typeof(p_job) is distinct from 'object' or jsonb_typeof(p_payload) is distinct from 'object' or p_job->>'status' is distinct from 'created' or p_job->>'result' is not null then raise exception 'INVALID_JOB'; end if;
  insert into public.make_budgets(scope,cap_micros) values(p_scope,p_cap_micros) on conflict do nothing;
  -- One scope row serializes reservations, idempotency keys and plan attempt limits.
  select * into b from public.make_budgets where scope = p_scope for update;
  select * into existing from public.generation_jobs where scope = p_scope and idempotency_key = p_key;
  if found then
    if existing.input_hash is distinct from p_input_hash or existing.session_id::text is distinct from (p_job->>'sessionId') or existing.data->>'operation' is distinct from p_job->>'operation' or existing.data->>'parentRevisionId' is distinct from p_job->>'parentRevisionId' or existing.data->>'planId' is distinct from p_job->>'planId' then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing.data;
  end if;
  if not exists(select 1 from public.design_sessions where id = (p_job->>'sessionId')::uuid and scope = p_scope) then raise exception 'NOT_FOUND'; end if;
  if p_job->>'parentRevisionId' is not null and not exists(select 1 from public.design_records where id = (p_job->>'parentRevisionId')::uuid and session_id = (p_job->>'sessionId')::uuid and kind = 'revision') then raise exception 'PARENT_NOT_FOUND'; end if;
  if p_job->>'planId' is not null then
    select * into plan from public.design_records where id = (p_job->>'planId')::uuid and session_id = (p_job->>'sessionId')::uuid and kind = 'plan' and data->>'parentRevisionId' = p_job->>'parentRevisionId';
    if not found then raise exception 'PLAN_NOT_FOUND'; end if;
    if (select count(*) from public.generation_jobs where session_id = (p_job->>'sessionId')::uuid and data->>'planId' = p_job->>'planId') >= 2 then raise exception 'REVISION_LIMIT'; end if;
  end if;
  if p_reserve_micros > b.cap_micros - b.spent_micros - b.reserved_micros then raise exception 'BUDGET_EXCEEDED'; end if;
  update public.make_budgets set reserved_micros = reserved_micros + p_reserve_micros where scope = p_scope;
  insert into public.generation_jobs(id,session_id,scope,idempotency_key,input_hash,data,payload,reserve_micros)
    values((p_job->>'id')::uuid,(p_job->>'sessionId')::uuid,p_scope,p_key,p_input_hash,p_job,p_payload,p_reserve_micros);
  insert into public.generation_job_events(job_id,kind,data) values((p_job->>'id')::uuid,'created',jsonb_build_object('reservedMicros',p_reserve_micros));
  return p_job;
end $$;

create function public.mr_claim_job(p_id uuid,p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.generation_jobs;
begin
  if p_owner is null then raise exception 'INVALID_LEASE_OWNER'; end if;
  select * into j from public.generation_jobs where id = p_id for update;
  if not found or j.data->>'status' in ('completed','failed','submission_unknown') then return null; end if;
  if j.lease_until > clock_timestamp() then return null; end if;
  if coalesce((j.payload->>'dispatchInFlight')::boolean,false) then
    update public.generation_jobs set data = data || jsonb_build_object('status','submission_unknown','error',jsonb_build_object('code','SUBMISSION_UNKNOWN','message','Paid submission outcome is unknown; automatic resubmission is disabled.','retryable',false),'updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),lease_owner = null,lease_until = null,fence = fence + 1,updated_at = now() where id = p_id;
    insert into public.generation_job_events(job_id,kind) values(p_id,'submission_unknown'); return null;
  end if;
  -- Longer than the bounded 300-second executor invocation, without a browser heartbeat.
  update public.generation_jobs set lease_owner = p_owner,lease_until = clock_timestamp() + interval '6 minutes',fence = fence + 1 where id = p_id returning * into j;
  insert into public.generation_job_events(job_id,kind,data) values(p_id,'claimed',jsonb_build_object('fence',j.fence));
  return to_jsonb(j);
end $$;

create function public.mr_patch_job(p_id uuid,p_fence bigint,p_patch jsonb,p_payload jsonb default null,p_provider_ref jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.generation_jobs;
begin
  select * into j from public.generation_jobs where id = p_id for update;
  if not found or j.fence is distinct from p_fence or j.lease_owner is null or j.lease_until is null or j.lease_until <= clock_timestamp() or j.data->>'status' in ('completed','failed','submission_unknown') then raise exception 'STALE_LEASE'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or (p_payload is not null and jsonb_typeof(p_payload) is distinct from 'object') then raise exception 'INVALID_PATCH'; end if;
  if p_patch ?| array['id','sessionId','parentRevisionId','planId','operation','createdAt','estimatedCostUsd','result'] or p_patch->>'status' in ('completed','failed','submission_unknown') then raise exception 'IMMUTABLE_JOB_FIELD'; end if;
  if p_provider_ref is not null and j.provider_ref is not null and p_provider_ref is distinct from j.provider_ref then raise exception 'PROVIDER_REF_CONFLICT'; end if;
  update public.generation_jobs set data = data || p_patch || jsonb_build_object('updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    payload = case when p_payload is null then payload else payload || p_payload end,
    provider_ref = coalesce(p_provider_ref,provider_ref),updated_at = now() where id = p_id returning * into j;
  insert into public.generation_job_events(job_id,kind,data) values(p_id,coalesce(p_patch->>'status','checkpoint'),p_patch);
  return j.data;
end $$;

create function public.mr_release_job(p_id uuid,p_fence bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin update public.generation_jobs set lease_owner = null,lease_until = null,fence = fence + 1 where id = p_id and fence = p_fence and lease_owner is not null; end $$;

create function public.mr_finish_job(p_id uuid,p_fence bigint,p_record jsonb,p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.generation_jobs; stored jsonb;
begin
  select * into j from public.generation_jobs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_kind is null or p_kind not in ('revision','plan') then raise exception 'INVALID_RECORD_KIND'; end if;
  select data into stored from public.design_records where source_job_id = p_id and kind = p_kind;
  if found then
    if stored is distinct from p_record then raise exception 'FINALIZATION_CONFLICT'; end if;
    return stored;
  end if;
  if j.fence is distinct from p_fence or j.lease_owner is null or j.lease_until is null or j.lease_until <= clock_timestamp() or j.data->>'status' in ('completed','failed','submission_unknown') then raise exception 'STALE_LEASE'; end if;
  if jsonb_typeof(p_record) is distinct from 'object' or p_record->>'sessionId' is distinct from j.session_id::text then raise exception 'SESSION_MISMATCH'; end if;
  if (p_kind = 'plan') is distinct from (j.data->>'operation' = 'planning') then raise exception 'INVALID_RECORD_KIND'; end if;
  -- Trigger validates same-session lineage, canonical artifacts and required kinds.
  insert into public.design_records(id,session_id,kind,data,source_job_id) values((p_record->>'id')::uuid,j.session_id,p_kind,p_record,p_id);
  update public.generation_jobs set data = data || jsonb_build_object('status','completed','progress',100,'result',jsonb_build_object(case when p_kind = 'revision' then 'revisionId' else 'planId' end,p_record->>'id'),'error',null,'updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),settled = true,lease_owner = null,lease_until = null,fence = fence + 1,updated_at = now() where id = p_id;
  if not j.settled then update public.make_budgets set reserved_micros = reserved_micros - j.reserve_micros,spent_micros = spent_micros + j.reserve_micros where scope = j.scope; end if;
  update public.design_sessions set updated_at = now() where id = j.session_id;
  insert into public.generation_job_events(job_id,kind,data) values(p_id,'completed',jsonb_build_object('recordId',p_record->>'id','recordKind',p_kind));
  return p_record;
end $$;

create function public.mr_fail_job(p_id uuid,p_fence bigint,p_error jsonb,p_unknown boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.generation_jobs;
begin
  select * into j from public.generation_jobs where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if j.data->>'status' in ('completed','failed','submission_unknown') then return; end if;
  if j.fence is distinct from p_fence or j.lease_owner is null or j.lease_until is null or j.lease_until <= clock_timestamp() then raise exception 'STALE_LEASE'; end if;
  if p_unknown is null or jsonb_typeof(p_error) is distinct from 'object' then raise exception 'INVALID_ERROR'; end if;
  update public.generation_jobs set data = data || jsonb_build_object('status',case when p_unknown then 'submission_unknown' else 'failed' end,'error',p_error,'updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),lease_owner = null,lease_until = null,fence = fence + 1,settled = not p_unknown,updated_at = now() where id = p_id;
  -- Conservatively charge reservations on known termination; unknown keeps them held.
  if not p_unknown and not j.settled then update public.make_budgets set reserved_micros = reserved_micros - j.reserve_micros,spent_micros = spent_micros + j.reserve_micros where scope = j.scope; end if;
  insert into public.generation_job_events(job_id,kind,data) values(p_id,case when p_unknown then 'submission_unknown' else 'failed' end,p_error);
end $$;

alter table public.design_sessions enable row level security;
alter table public.make_budgets enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.design_records enable row level security;
alter table public.make_artifacts enable row level security;
alter table public.generation_job_events enable row level security;
revoke all on public.design_sessions,public.make_budgets,public.generation_jobs,public.design_records,public.make_artifacts,public.generation_job_events from public,anon,authenticated;
grant all on public.design_sessions,public.make_budgets,public.generation_jobs,public.design_records,public.make_artifacts,public.generation_job_events to service_role;
grant usage,select on sequence public.generation_job_events_id_seq to service_role;
revoke execute on function public.mr_immutable(),public.mr_verified_artifact_immutable(),public.mr_validate_record(),public.mr_create_job(text,jsonb,jsonb,text,text,bigint,bigint),public.mr_claim_job(uuid,uuid),public.mr_patch_job(uuid,bigint,jsonb,jsonb,jsonb),public.mr_release_job(uuid,bigint),public.mr_finish_job(uuid,bigint,jsonb,text),public.mr_fail_job(uuid,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.mr_create_job(text,jsonb,jsonb,text,text,bigint,bigint),public.mr_claim_job(uuid,uuid),public.mr_patch_job(uuid,bigint,jsonb,jsonb,jsonb),public.mr_release_job(uuid,bigint),public.mr_finish_job(uuid,bigint,jsonb,text),public.mr_fail_job(uuid,bigint,jsonb,boolean) to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('makeready','makeready',false,52428800) on conflict(id) do nothing;
