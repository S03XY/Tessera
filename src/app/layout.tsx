import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { SiteRail } from "@/components/site-rail";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

/*
 * Archivo for language, IBM Plex Mono for anything the machine produced.
 * Archivo is a grotesque drawn for signage and forms — it holds tight
 * negative tracking at display sizes without the softness that makes most
 * UI sans faces interchangeable.
 */
const display = Archivo({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-mono-face",
});

export const metadata: Metadata = {
  title: {
    default: "Tessera — the MCP marketplace, priced per tool",
    template: "%s · Tessera",
  },
  description:
    "Upload an API and we publish it as an MCP server. Price each tool free or paid. " +
    "Agents connect to one URL and settle paid calls on Hedera over x402.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      {/*
        The rail is fixed, so the document is inset by its width rather than
        laid out beside it — that keeps every page's own grid free of a
        navigation column it would otherwise have to reason about.
      */}
      <body className="antialiased">
        <SiteRail />
        <div className="flex min-h-screen flex-col pb-[58px] lg:pb-0 lg:pl-[92px]">
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
