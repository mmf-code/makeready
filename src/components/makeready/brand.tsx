import type { CSSProperties } from "react";

import { REST_PATH } from "./hamur/engine";

/** The HAMUR mark: Hamur's rest pose, drawn from the same path the character animates. */
export function Logo({ className = "h-7 w-[42px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 400" className={`text-clay ${className}`} aria-hidden="true">
      <path fill="currentColor" d={REST_PATH} />
    </svg>
  );
}

export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className="flex items-center gap-2.5 text-clay">
      <Logo className={size === "lg" ? "h-10 w-[60px]" : "h-7 w-[42px]"} />
      <b className={`mr-display ${size === "lg" ? "text-[40px]" : "text-[28px]"} leading-none`}>MakeReady</b>
    </span>
  );
}

export type HatKind = "foreman" | "design" | "inspect" | "tech" | "maker" | "courier" | "buyer" | "person" | "machine";

const HAT_VAR: Record<string, string> = {
  foreman: "var(--hat-foreman)", design: "var(--hat-design)", inspect: "var(--hat-inspect)", tech: "var(--hat-tech)",
  maker: "var(--hat-maker)", courier: "var(--hat-courier)", buyer: "var(--hat-buyer)",
};

/** A hard hat in the builder's role color. People and machines get their own glyphs. */
export function Hat({ kind, className = "size-4" }: { kind: HatKind; className?: string }) {
  if (kind === "person") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path d="M4 21c1.2-4.2 4.3-6.5 8-6.5s6.8 2.3 8 6.5z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "machine") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M8 7h8M9 17h6" />
        <rect x="9" y="10" width="6" height="4" fill="var(--uv)" stroke="none" />
      </svg>
    );
  }
  const fill = { fill: HAT_VAR[kind] } as CSSProperties;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M4.6 17.2C4.6 12.3 7.9 8.4 12 8.4s7.4 3.9 7.4 8.8z" style={fill} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 8.4v5.2M8.4 10.2l.9 3.6M15.6 10.2l-.9 3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="2" y="17" width="20" height="2.8" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export type StationState = "idle" | "working" | "attention" | "problem" | "done";

/** Three-segment andon light. Exactly one segment lights per state. */
export function Andon({ state }: { state: StationState }) {
  const lit = (i: number) =>
    (i === 0 && (state === "working" || state === "done")) || (i === 1 && state === "attention") || (i === 2 && state === "problem");
  const color = ["var(--go)", "var(--wait)", "var(--stop)"];
  return (
    <span className="flex h-[30px] w-3 flex-col gap-0.5" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          className="flex-1 rounded-[3px]"
          style={{
            background: lit(i) ? color[i] : "var(--line)",
            boxShadow: lit(i) && state !== "done" ? `0 0 8px ${color[i]}` : undefined,
          }}
        />
      ))}
    </span>
  );
}
