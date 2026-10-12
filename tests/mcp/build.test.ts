import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpView, collectMcpViewSourceHashes } from "../../scripts/build-mcp-view.mjs";
import { mcpView } from "../../src/lib/mcp/view.generated";

interface GeneratedView { html: string; sha256: string; sourceHashes: Record<string, string> }
const repository = resolve(".");

async function put(root: string, path: string, contents: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}
async function fixture(root: string) {
  await mkdir(root, { recursive: true });
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  await put(root, "package.json", '{"name":"mcp-build-fixture","private":true,"packageManager":"pnpm@10.33.2"}');
  await put(root, "scripts/build-mcp-view.mts", await readFile(join(repository, "scripts/build-mcp-view.mts"), "utf8"));
  await put(root, "src/components/mcp-view/entry.tsx", 'import { color } from "./card"; document.body.className = `text-red-500 ${color}`;');
  await put(root, "src/components/mcp-view/card.tsx", 'export const color = "bg-blue-500";');
  await put(root, "src/app/globals.css", '@import "tailwindcss";\n@import "./tokens.css";\nbody { --fixture-style: preserved; }');
  await put(root, "src/app/tokens.css", '.fixture-token { color: rgb(1, 2, 3); }');
}
async function generated(root: string): Promise<GeneratedView> {
  const generatedModule = await readFile(join(root, "src/lib/mcp/view.generated.ts"), "utf8");
  return JSON.parse(generatedModule.slice(generatedModule.indexOf("= ") + 2, generatedModule.lastIndexOf(" as const;")));
}

describe("deterministic MCP View build", () => {
  it("ignores unrelated files and has identical output without git in a source archive", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "makeready-mcp-build-"));
    try {
      const local = join(temporary, "local");
      const archive = join(temporary, "archive");
      await fixture(local);
      await fixture(archive);
      await put(local, ".gitignore", "tests/\n");
      await put(local, "tests/unrelated.ts", 'export const irrelevant = "bg-fuchsia-700 p-96";');
      await put(archive, "scripts/unrelated.ts", 'export const irrelevant = "bg-lime-950 m-96";');
      const globalsBefore = await readFile(join(local, "src/app/globals.css"), "utf8");
      await buildMcpView({ rootDirectory: local, quiet: true });
      const first = await generated(local);
      await put(local, "src/components/unimported.tsx", 'export const unrelated = "bg-orange-950";');
      await buildMcpView({ rootDirectory: local, quiet: true });
      expect(await generated(local)).toEqual(first);
      await buildMcpView({ rootDirectory: archive, quiet: true });
      expect(await generated(archive)).toEqual(first);
      expect(first.html).toContain(".text-red-500");
      expect(first.html).toContain(".bg-blue-500");
      expect(first.html).not.toContain(".bg-fuchsia-700");
      expect(first.html).not.toContain(".bg-orange-950");
      expect(first.html).toContain("--fixture-style:preserved");
      expect(first.html).toContain(".fixture-token");
      expect(Object.keys(first.sourceHashes)).toContain("src/app/tokens.css");
      expect(Object.keys(first.sourceHashes).some((path) => path.endsWith("tailwindcss/index.css"))).toBe(true);
      expect(await readFile(join(local, "src/app/globals.css"), "utf8")).toBe(globalsBefore);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }, 20_000);

  it("detects an added file changing import resolution even when the importer is unchanged", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "makeready-mcp-inputs-"));
    try {
      await fixture(temporary);
      await rm(join(temporary, "src/components/mcp-view/card.tsx"));
      await put(temporary, "src/components/mcp-view/card.ts", 'export const color = "bg-blue-500";');
      await buildMcpView({ rootDirectory: temporary, quiet: true });
      const before = await generated(temporary);
      const entryBefore = await readFile(join(temporary, "src/components/mcp-view/entry.tsx"), "utf8");
      await put(temporary, "src/components/mcp-view/card.tsx", 'export const color = "bg-lime-900";');
      const current = await collectMcpViewSourceHashes(temporary);
      expect(current).not.toEqual(before.sourceHashes);
      expect(Object.keys(current)).toContain("src/components/mcp-view/card.tsx");
      expect(Object.keys(current)).not.toContain("src/components/mcp-view/card.ts");
      expect(await readFile(join(temporary, "src/components/mcp-view/entry.tsx"), "utf8")).toBe(entryBefore);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }, 20_000);

  it("records the current complete input graph, including newly resolved imports", async () => {
    if (!existsSync(join(repository, "src/components/mcp-view/entry.tsx"))) return;
    expect(mcpView.available).toBe(true);
    expect(await collectMcpViewSourceHashes(repository), "MCP View input graph changed; run pnpm build:mcp-view.").toEqual(mcpView.sourceHashes);
  });
});
