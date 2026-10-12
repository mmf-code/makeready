import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError, databaseError } from "./errors";

let client: SupabaseClient | undefined;
export function getDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AppError("PROVIDER_UNAVAILABLE", "MakeReady database is not configured.", 503);
  return client ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {fetch:(input,init)=>fetch(input,{...init,signal:init?.signal||AbortSignal.timeout(45_000)})},
  });
}
export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getDb().rpc(name, args);
  if (error) databaseError(error);
  return data as T;
}
export async function checked<Q extends PromiseLike<{data:unknown,error:{message:string}|null}>>(query:Q): Promise<NonNullable<Awaited<Q>["data"]>> {
  const {data,error}=await query;
  if(error) databaseError(error);
  if(data===null) throw new AppError("NOT_FOUND", "Record not found.",404);
  return data as NonNullable<Awaited<Q>["data"]>;
}
