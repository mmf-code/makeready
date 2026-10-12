import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpView } from "../../src/lib/mcp/view.generated";

describe("MCP App resource", () => {
  it("never advertises a placeholder as a completed View", () => {
    if (!existsSync(resolve("src/components/mcp-view/entry.tsx"))) expect(mcpView.available).toBe(false);
    if (!mcpView.available) {
      expect(mcpView.html).toBe("");
      expect(mcpView.resourceUri).toBe("");
    }
  });

  it("is rebuilt whenever the View or one of its inputs changes", async () => {
    if (!existsSync(resolve("src/components/mcp-view/entry.tsx"))) return;
    expect(mcpView.available, "Run pnpm build:mcp-view after Claude's View lands.").toBe(true);
    expect(mcpView.sha256).toBe(hash(mcpView.html));
    expect(mcpView.resourceUri).toBe(`ui://makeready/view-${mcpView.sha256.slice(0, 12)}.html`);
    expect(Object.keys(mcpView.sourceHashes).length).toBeGreaterThan(0);
    for (const [path, expected] of Object.entries(mcpView.sourceHashes)) {
      expect(hash(await readFile(resolve(path))), `${path} changed; run pnpm build:mcp-view.`).toBe(expected);
    }
  });
});

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
