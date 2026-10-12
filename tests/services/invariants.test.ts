import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { assertApproved, budgetMicros } from "../../src/lib/services";
import { assertImage } from "../../src/lib/storage";
import { exampleV1 as revisionV1, exampleV2 as revisionV2 } from "../../src/lib/contracts/fixtures";

afterEach(()=>vi.unstubAllEnvs());
describe("approval binds the actual immutable artifact set",()=>{
  it("rejects a child when only its parent was approved",()=>{
    expect(()=>assertApproved(revisionV2,[{decision:"approve",artifactHashes:revisionV1.artifacts.map(a=>a.sha256)}])).toThrow(/exact revision/);
  });
  it("honors the latest rejection and does not mutate artifact order",()=>{
    const hashes=revisionV1.artifacts.map(a=>a.sha256),before=JSON.stringify(revisionV1);
    expect(()=>assertApproved(revisionV1,[{decision:"approve",artifactHashes:hashes},{decision:"reject",artifactHashes:hashes}])).toThrow();
    expect(JSON.stringify(revisionV1)).toBe(before);
  });
  it("accepts the exact hash set regardless of ordering",()=>{
    expect(()=>assertApproved(revisionV1,[{decision:"approve",artifactHashes:revisionV1.artifacts.map(a=>a.sha256).reverse()}])).not.toThrow();
  });
});
describe("stored images must actually decode",()=>{
  it.each(["png","jpeg","webp"] as const)("reads real %s pixels",async format=>{
    const bytes=await sharp({create:{width:12,height:10,channels:3,background:"red"}}).toFormat(format).toBuffer();
    await expect(assertImage(bytes,`image/${format}`)).resolves.toBeUndefined();
  });
  it("rejects a valid signature with corrupt pixel data",async()=>{
    const bytes=Buffer.alloc(100);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    await expect(assertImage(bytes,"image/png")).rejects.toMatchObject({code:"INVALID_ARTIFACT"});
  });
});
it("does not allow environment configuration to bypass the demo budget ceiling",()=>{
  vi.stubEnv("MAKE_BUDGET_USD","50.01");expect(()=>budgetMicros()).toThrow();
  vi.stubEnv("MAKE_BUDGET_USD","10");expect(budgetMicros()).toBe(10_000_000);
});
