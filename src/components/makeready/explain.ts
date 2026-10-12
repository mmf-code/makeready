import { MakeReadyClientError } from "@/lib/client";

/* ---------- errors in plain words ---------- */
export function explain(error: unknown): string {
  if (!(error instanceof MakeReadyClientError)) return error instanceof Error ? error.message : "Something went wrong.";
  switch (error.code) {
    case "BUDGET_EXCEEDED": return "This would go over the spending limit set for the demo. Nothing was charged.";
    case "CONFIRM_COST_REQUIRED": return "This step costs money and needs confirmation. Nothing was charged.";
    case "SUBMISSION_UNKNOWN":
    case "TRANSPORT_AMBIGUOUS": return "The answer from the server got lost. The request may have gone through, so it was not sent again. Refresh the run to see it.";
    case "CONFLICT": return error.message || "This step does not match the current state of the run. Refresh and try again.";
    case "NOT_READY": return "The package is not ready yet. The run keeps going on the server.";
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_FAILED": return `The provider failed: ${error.message}`;
    case "NETWORK_ERROR":
    case "POLLING_FAILED": return "Can't reach MakeReady right now. The run continues on the server.";
    default: return error.message;
  }
}

