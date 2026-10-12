"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MakeReadyClientError, unlock } from "@/lib/client";
import { safePath } from "./safe-path";

export function AccessForm({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await unlock({ password, returnTo });
      router.replace(safePath(result.redirectTo));
    } catch (e) {
      setError(e instanceof MakeReadyClientError && e.code === "ACCESS_REQUIRED" ? "That password did not open the gate. Check it and try again." : "Can't reach MakeReady right now. Try again in a moment.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor="password" className="text-[14px] font-bold">Demo password</label>
      <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
        className="min-h-12 rounded-xl border-[1.5px] border-line bg-panel px-3.5 text-[17px] text-ink" />
      <button type="submit" disabled={busy || !password}
        className="inline-flex min-h-12 items-center justify-center rounded-full border-[1.5px] border-tape-ink bg-tape px-6 text-[17px] font-extrabold text-tape-ink disabled:opacity-60">
        {busy ? "Opening" : "Open the gate"}
      </button>
      {error && <p role="alert" className="m-0 text-[14px] text-ink">{error}</p>}
    </form>
  );
}
