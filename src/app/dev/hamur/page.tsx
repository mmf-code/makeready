import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HamurSheet } from "@/components/makeready/hamur/sheet";

export const metadata: Metadata = { title: "Hamur", robots: { index: false, follow: false } };

/** Hamur's model sheet and motion playground. Development only. */
export default function HamurPage() {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") notFound();
  return <HamurSheet />;
}
