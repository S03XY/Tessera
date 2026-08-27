"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const NAV = [
  { href: "/services", label: "Services" },
  { href: "/sellers", label: "Sellers" },
  { href: "/activity", label: "Activity" },
  { href: "/agent", label: "Agent" },
  { href: "/onboarding", label: "Sell" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-[6px]">
      <div className="mx-auto flex h-13 max-w-[1120px] items-center gap-6 px-5 sm:px-8">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-sm text-ink"
          aria-label="Tollgate home"
        >
          <GateMark />
          <span className="text-[14px] font-[560] tracking-[-0.015em]">Tollgate</span>
        </Link>

        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto scroll-thin">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
                  active
                    ? "text-ink"
                    : "text-ink-3 hover:bg-bg-sunken hover:text-ink",
                )}
              >
                {item.label}
                {active && (
                  <span className="absolute inset-x-2.5 -bottom-[13px] h-px bg-ink" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-line-2 bg-bg-subtle px-2 py-0.5 text-[11.5px] text-ink-2 sm:inline-flex">
            <span className="size-1.5 rounded-full bg-ok" />
            Hedera testnet
          </span>
        </div>
      </div>
    </header>
  );
}

/** Two posts and a rising bar — a toll gate, drawn on the 16px grid. */
function GateMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-[18px]" aria-hidden="true">
      <rect x="1" y="4" width="2.5" height="9" rx="0.6" fill="currentColor" />
      <rect x="12.5" y="4" width="2.5" height="9" rx="0.6" fill="currentColor" />
      <rect
        x="3"
        y="6.2"
        width="10.5"
        height="2.2"
        rx="0.6"
        fill="currentColor"
        opacity="0.45"
        transform="rotate(-11 3 6.2)"
      />
    </svg>
  );
}
