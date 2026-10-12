import type { Metadata, Viewport } from "next";
import { Bagel_Fat_One, DM_Mono, Nunito_Sans } from "next/font/google";
import "./globals.css";

const nunito = Nunito_Sans({ variable: "--font-nunito", subsets: ["latin", "latin-ext"], display: "swap" });
const bagel = Bagel_Fat_One({ variable: "--font-bagel", weight: "400", subsets: ["latin", "latin-ext"], display: "swap" });
const dmMono = DM_Mono({ variable: "--font-dmmono", weight: ["400", "500"], subsets: ["latin", "latin-ext"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "MakeReady", template: "%s | MakeReady" },
  description: "Fikrine biçim ver. One message from you; agents design, check and hand your figurine to makers through tool calls.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f3f1" },
    { media: "(prefers-color-scheme: dark)", color: "#141418" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${nunito.variable} ${bagel.variable} ${dmMono.variable} h-full antialiased`}>
      <body className="mr-app min-h-full">{children}</body>
    </html>
  );
}
