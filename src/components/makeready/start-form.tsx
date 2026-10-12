"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createSession, MakeReadyClientError, startDesign, uploadSourceImage } from "@/lib/client";
import { explain } from "./explain";

const USES = ["Hand-painted tabletop figurine", "Desk decor", "Birthday gift figurine"];
const EXAMPLE = "Kedimin 12 cm'lik, elle boyanmış bir figürünü yap. Atkısı mavi olsun, doğum günü hediyesi.";
const RECENT_KEY = "makeready.recentRuns";

export interface RecentRun { id: string; title: string; at: string }
export function readRecent(): RecentRun[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentRun[]; } catch { return []; }
}
function remember(run: RecentRun) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([run, ...readRecent().filter((r) => r.id !== run.id)].slice(0, 6))); } catch { /* storage is optional */ }
}

export function StartForm() {
  const router = useRouter();
  const [message, setMessage] = useState(EXAMPLE);
  const [height, setHeight] = useState(120);
  const [use, setUse] = useState(USES[0]);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (stage) return;
    setError(null);
    setConfirming(true);
  }

  async function start() {
    setConfirming(false);
    if (stage) return;
    key.current ??= `start-${crypto.randomUUID()}`;
    try {
      let sessionId: string | undefined;
      let imageArtifactId: string | undefined;
      if (file) {
        setStage("Uploading your photo");
        const session = await createSession({ title: message.slice(0, 160) });
        sessionId = session.id;
        const artifact = await uploadSourceImage(session.id, file, { fileName: file.name || "photo.jpg", onProgress: (p) => setStage(p.message) });
        imageArtifactId = artifact.id;
      }
      setStage("Handing your message to the foreman");
      const result = await startDesign({ prompt: message.trim(), heightMm: height, use, sessionId, imageArtifactId, confirmCost: true, idempotencyKey: key.current });
      remember({ id: result.sessionId, title: message.slice(0, 80), at: new Date().toISOString() });
      router.push(`/runs/${result.sessionId}`);
    } catch (e) {
      if (e instanceof MakeReadyClientError && e.code === "ACCESS_REQUIRED") { router.push("/access?returnTo=/"); return; }
      setError(explain(e));
      setStage(null);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-[20px] border-[1.5px] border-line bg-panel p-5">
      <div className="flex items-start gap-3.5">
        <label htmlFor="photo" className="grid size-[86px] shrink-0 cursor-pointer place-items-center overflow-hidden rounded-[14px] border-2 border-dashed border-ink-2 bg-panel-2 text-center text-xs leading-tight text-ink-2">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your photo" className="size-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-1 px-1">
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="12" cy="12" r="3.4" /></svg>
              Add a photo
            </span>
          )}
          <input id="photo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="message" className="text-[13px] font-bold text-ink-2">Your one message. Agents take it from here.</label>
          <textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} required maxLength={6000}
            className="min-h-[96px] resize-y rounded-xl border-[1.5px] border-line bg-panel px-3.5 py-2.5 text-[18px] leading-snug font-semibold text-ink" />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="height" className="text-[13px] font-bold text-ink-2">Height</label>
          <div className="flex min-h-12 items-center gap-2 rounded-xl border-[1.5px] border-line px-3">
            <input id="height" type="number" min={30} max={300} value={height} onChange={(e) => setHeight(Number(e.target.value) || 120)}
              className="w-16 bg-transparent text-lg font-bold tabular-nums text-ink" />
            <span className="text-ink-2">mm</span>
          </div>
        </div>
        <fieldset className="m-0 flex min-w-0 flex-1 flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[13px] font-bold text-ink-2">Made for</legend>
          <div className="flex flex-wrap gap-1.5">
            {USES.map((u) => (
              <label key={u} className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border-[1.5px] px-3.5 text-[14px] font-semibold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ink ${use === u ? "border-clay bg-clay text-clay-ink" : "border-line bg-panel-2 text-ink"}`}>
                <input type="radio" name="use" value={u} checked={use === u} onChange={() => setUse(u)} className="sr-only" />{u}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t-[1.5px] border-dashed border-line pt-4">
        <button type="submit" disabled={!!stage || confirming || !message.trim()}
          className="inline-flex min-h-[52px] items-center gap-2 rounded-full border-[1.5px] border-clay bg-clay px-6 text-[17px] font-extrabold text-clay-ink disabled:cursor-wait disabled:opacity-60">
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>
          {stage ?? "Start the run"}
        </button>
        <span className="min-w-[14em] flex-1 text-[14px] text-ink-2">Nothing is charged before you approve it. Autopilot spending is off for now.</span>
      </div>
      {confirming && (
        <div role="group" aria-label="Approve spending" className="flex flex-wrap items-center gap-3 rounded-2xl border-[1.5px] border-clay bg-clay-soft px-4 py-3">
          <p className="m-0 min-w-[16em] flex-1 text-[15px]">
            <b>{file ? "Start with your photo." : "Start with a concept image, about $0.50."}</b>{" "}
            {file ? "Your photo becomes concept v1 and the look inspector checks it." : "The concept agent draws v1 and the look inspector checks it."} Each later paid step asks you again.
          </p>
          <button type="button" onClick={start} className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-clay bg-clay px-5 font-extrabold text-clay-ink">Approve and start</button>
          <button type="button" onClick={() => setConfirming(false)} className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-ink bg-panel px-5 font-bold">Not now</button>
        </div>
      )}
      {error && <p role="alert" className="m-0 rounded-xl bg-[color-mix(in_srgb,var(--stop)_14%,var(--panel))] px-3 py-2 text-[14px]">{error}</p>}
    </form>
  );
}

const noSubscribe = () => () => {};
function recentSnapshot() { try { return localStorage.getItem(RECENT_KEY) ?? "[]"; } catch { return "[]"; } }

export function RecentRuns() {
  const raw = useSyncExternalStore(noSubscribe, recentSnapshot, () => "[]");
  const runs = useMemo<RecentRun[]>(() => { try { return JSON.parse(raw) as RecentRun[]; } catch { return []; } }, [raw]);
  if (!runs.length) return null;
  return (
    <nav aria-label="Your recent runs" className="flex flex-wrap items-center gap-2 text-[14px]">
      <span className="font-bold text-ink-2">Your recent runs</span>
      {runs.map((r) => <Link key={r.id} href={`/runs/${r.id}`} className="max-w-[24ch] truncate rounded-full border-[1.5px] border-line bg-panel px-3 py-1.5 font-semibold">{r.title}</Link>)}
    </nav>
  );
}
