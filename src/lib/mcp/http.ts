import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMakeReadyMcpServer, type MakeReadyMcpServices } from "./server";
import type { ViewResourceOptions } from "./resource";

export interface McpHttpOptions extends ViewResourceOptions {
  secret?: string;
  createServices: () => MakeReadyMcpServices;
}

/** Access validation precedes server/service construction. The secret never enters the UI. */
export async function handleMakeReadyMcp(request: Request, pathSecret: string, options: McpHttpOptions): Promise<Response> {
  if (!validSecret(pathSecret, options.secret)) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false } }, {
      status: 404, headers: { "Cache-Control": "no-store" },
    });
  }
  const handler = createMcpHandler(() => createMakeReadyMcpServer(options.createServices(), options), {
    legacy: "stateless",
  });
  const response = await handler.fetch(request);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

function validSecret(actual: string, expected?: string): boolean {
  if (!expected || expected.length < 32) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
