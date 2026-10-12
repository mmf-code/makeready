import type { Metadata } from "next";
import { Wordmark } from "@/components/makeready/brand";
import { Hamur } from "@/components/makeready/hamur/hamur";
import { AccessForm } from "@/components/makeready/access-form";
import { safePath } from "@/components/makeready/safe-path";

export const metadata: Metadata = { title: "Demo access" };

export default async function AccessPage({ searchParams }: PageProps<"/access">) {
  const params = await searchParams;
  const returnTo = safePath(params.returnTo);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <Wordmark />
        <div className="overflow-hidden rounded-[28px] border-[1.5px] border-line bg-panel">
          <div className="mr-stage flex justify-center px-6 pt-10 pb-4"><Hamur size={240} playful label="Hamur" /></div>
          <div className="flex flex-col gap-4 p-6">
            <h1 className="mr-heading m-0 text-[34px] text-ink">Studio access</h1>
            <p className="m-0 text-[15px] text-ink-2">This demo spends real provider credits, so the studio is locked. Enter the password from the team.</p>
            <AccessForm returnTo={returnTo} />
          </div>
        </div>
      </div>
    </main>
  );
}
