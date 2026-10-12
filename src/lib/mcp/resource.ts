import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { mcpView } from "./view.generated";

export interface ViewResourceOptions {
  storageUrl?: string;
  appUrl?: string;
}

export function getViewToolMetadata(): Record<string, unknown> {
  if (!mcpView.available) return {};
  return {
    ui: { resourceUri: mcpView.resourceUri, visibility: ["model", "app"] },
    "openai/outputTemplate": mcpView.resourceUri,
    "openai/widgetAccessible": true,
  };
}

export function registerViewResource(server: McpServer, options: ViewResourceOptions): void {
  if (!mcpView.available) return;
  const storageOrigin = safeOrigin(options.storageUrl);
  const appOrigin = safeOrigin(options.appUrl);
  const connectDomains = [storageOrigin, appOrigin].filter((value): value is string => !!value);
  const resourceDomains = [...connectDomains, "https://fonts.googleapis.com", "https://fonts.gstatic.com"];
  const csp = { connectDomains, resourceDomains };
  const metadata = {
    ui: { csp, prefersBorder: true },
    "openai/widgetDescription": "MakeReady design history, agent refinement decisions, real 3D comparisons, and separate visual, physical, and human evaluations.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": { connect_domains: connectDomains, resource_domains: resourceDomains },
  };
  registerAppResource(server, "MakeReady View", mcpView.resourceUri, {
    mimeType: RESOURCE_MIME_TYPE,
    description: "Interactive MakeReady workspace. Artifact integrity is distinct from physical suitability.",
    _meta: metadata,
  }, async () => ({
    contents: [{
      uri: mcpView.resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: mcpView.html,
      _meta: metadata,
    }],
  }));
}

function safeOrigin(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return;
    return url.origin;
  } catch { return; }
}
