import { handleMakeReadyMcp } from "@/lib/mcp/http";
import { createServices } from "@/lib/services";
import { kickJob } from "@/lib/http";
import { accelerateMcpJobs } from "@/lib/mcp/execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ secret: string }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { secret } = await context.params;
  return handleMakeReadyMcp(request, secret, {
    secret: process.env.MCP_SECRET,
    appUrl: process.env.APP_URL,
    storageUrl: process.env.SUPABASE_URL,
    createServices: () => accelerateMcpJobs(createServices("demo"), kickJob),
  });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
