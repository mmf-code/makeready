import type { ApiError } from "./contracts";
export class AppError extends Error {
  constructor(public code: ApiError["code"], message: string, public status = 400, public retryable = false) { super(message); this.name = "AppError"; }
  toJSON(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export function databaseError(error: {message:string}): never {
  const text = error.message;
  if (text.includes("BUDGET_EXCEEDED")) throw new AppError("BUDGET_EXCEEDED", "The project budget is exhausted.", 402);
  if (text.includes("IDEMPOTENCY_CONFLICT")) throw new AppError("CONFLICT", "This idempotency key belongs to a different request.", 409);
  if (text.includes("FINALIZATION_CONFLICT")) throw new AppError("CONFLICT", "This job already finalized a different immutable result.", 409);
  if (text.includes("REVISION_LIMIT")) throw new AppError("CONFLICT", "This feedback plan has reached its two-attempt limit. Submit fresh feedback to create another plan.", 409);
  if (/ARTIFACT_NOT_VERIFIED|ARTIFACTS_REQUIRED|ARTIFACT_HASH_MISMATCH|DUPLICATE_ARTIFACT/.test(text)) throw new AppError("INVALID_ARTIFACT", "Stored artifacts do not match this revision's required verified files.", 422);
  if (/PARENT_NOT_FOUND|PLAN_NOT_FOUND|REVISION_NOT_FOUND/.test(text)) throw new AppError("NOT_FOUND", "The referenced design record was not found.", 404);
  if (text.includes("NOT_FOUND")) throw new AppError("NOT_FOUND", "Record not found.", 404);
  if (text.includes("STALE_LEASE")) throw new AppError("CONFLICT", "Another executor owns this job.", 409, true);
  throw new AppError("STORAGE_FAILED", "Durable storage operation failed.", 503, true);
}
