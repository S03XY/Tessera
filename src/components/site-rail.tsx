"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx, Lamp } from "@/components/ui";

/*
 * Navigation as the spine of the chassis rather than a bar across the top.
 *
 * Each destination is a function key milled into a vertical rail: an engraved
 * index, a stencilled label, and — when it is the current one — the key sits
 * *down* in the panel with a bright bar along its inner edge. A horizontal nav
 * has to signal "current" with an underline or a pill because everything sits
 * on one plane; a column of physical keys can just press one in.
 *
 * Below 1024px the rail lies down along the bottom edge, where a thumb is,
 * and the keys keep their material and their numbering.
 */
const NAV = [
  { href: "/services", label: "Services", n: "01" },
  { href: "/sellers", label: "Sellers", n: "02" },
  { href: "/activity", label: "Activity", n: "03" },
  { href: "/agent", label: "Agent", n: "04" },
  { href: "/onboarding", label: "Sell", n: "05" },
  { href: "/docs", label: "Docs", n: "06" },
];

export function SiteRail() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* ---------------------------------------------- desktop: the spine */}
      <div className="rail brushed fixed inset-y-0 left-0 z-40 hidden w-[92px] flex-col border-b-0 border-r border-r-black/70 lg:flex">
        {/*
          Travel gauge. A fixed rail hides the scrollbar's job, so the rail
          takes it over: a bright line up its outer edge tracking how far
          through the document you are.
        */}
        <span
          aria-hidden="true"
          className="scroll-gauge-y absolute inset-y-0 left-0 w-[2px] bg-ink/75"
        />
        <Link
          href="/"
          aria-label="Tessera home"
          className="grid h-[76px] shrink-0 place-items-center border-b border-black/55 shadow-[0_1px_0_var(--edge-hi)]"
        >
          <TesseraMark className="size-[26px]" />
        </Link>

        <nav
          aria-label="Primary"
          className="scroll-thin min-h-0 flex-1 overflow-y-auto"
        >
          {NAV.map((item) => (
            <RailKey key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </nav>

        <div className="shrink-0 border-t border-black/55 shadow-[inset_0_1px_0_var(--edge-hi)]">
          {/*
            The wordmark printed up the side of the case, the way a model name
            is screened onto equipment. It is the brand's only appearance, and
            it is deliberately not the first thing you read.
          */}
          <p
            className="engraved mx-auto py-5 font-mono text-[11px] font-semibold uppercase tracking-[0.42em] text-ink-3"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Tessera
          </p>
          <div
            className="flex flex-col items-center gap-1.5 border-t border-black/55 py-3.5 shadow-[inset_0_1px_0_var(--edge-hi)]"
            title="Hedera testnet"
          >
            <Lamp state="on" live />
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-4">
              testnet
            </span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------- mobile: the same rail,
          laid down along the bottom edge where the thumb already is. */}
      <div className="rail brushed fixed inset-x-0 bottom-0 z-40 flex border-t border-t-black/70 border-b-0 lg:hidden">
        <span
          aria-hidden="true"
          className="scroll-gauge-x absolute inset-x-0 bottom-0 h-[2px] bg-ink/75"
        />
        <Link
          href="/"
          aria-label="Tessera home"
          className="grid w-[56px] shrink-0 place-items-center border-r border-black/55 shadow-[1px_0_0_var(--edge-hi)]"
        >
          <TesseraMark className="size-[20px]" />
        </Link>
        <nav
          aria-label="Primary"
          className="scroll-thin flex min-w-0 flex-1 overflow-x-auto"
        >
          {NAV.map((item) => (
            <RailKey
              key={item.href}
              {...item}
              active={isActive(item.href)}
              horizontal
            />
          ))}
        </nav>
      </div>
    </>
  );
}

function RailKey({
  href,
  label,
  n,
  active,
  horizontal = false,
}: {
  href: string;
  label: string;
  n: string;
  active: boolean;
  horizontal?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "group relative flex flex-col justify-center transition-[background-color,box-shadow] duration-150",
        horizontal
          ? "h-[58px] min-w-[74px] shrink-0 items-center border-r border-black/45 px-3"
          : "h-[72px] w-full items-start border-b border-black/45 px-3.5",
        active
          ? /* Seated: the key is pressed into the rail. */
            "bg-black/45 shadow-[inset_0_2px_5px_rgba(0,0,0,0.8),inset_0_-1px_0_var(--edge-hi)]"
          : "hover:bg-white/[0.045]",
      )}
    >
      {/*
        The bright bar on the inner edge of the pressed key. It is the one
        piece of lit metal in the navigation, so there is never a question
        about which key is down.
      */}
      <span
        aria-hidden="true"
        className={cx(
          "absolute bg-ink transition-opacity duration-150",
          horizontal ? "inset-x-0 top-0 h-[2px]" : "inset-y-0 right-0 w-[2px]",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        className={cx(
          "font-mono text-[9.5px] leading-none tracking-[0.1em] transition-colors",
          active ? "text-ink-3" : "text-ink-4 group-hover:text-ink-3",
        )}
      >
        {n}
      </span>
      <span
        className={cx(
          "mt-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.11em] transition-colors",
          active ? "text-ink" : "text-ink-3 group-hover:text-ink",
        )}
      >
        {label}
      </span>
    </Link>
  );
}

/**
 * A tessera: the small chamfered token a Roman citizen presented for entry.
 * A milled octagonal blank with a slot cut through it — the slot is both the
 * mosaic tile's kerf and the coin slot the agent pays into. Lit from above
 * like every other part, so the top chamfer is bright and the bottom one
 * falls into shadow.
 */
export function TesseraMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-hidden="true">
      <defs>
        <linearGradient id="tsr-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d8d8d4" />
          <stop offset="52%" stopColor="#8f8f8c" />
          <stop offset="100%" stopColor="#4a4a4c" />
        </linearGradient>
      </defs>
      <path
        d="M4.6 1.4h6.8L14.6 4.6v6.8L11.4 14.6H4.6L1.4 11.4V4.6Z"
        fill="url(#tsr-face)"
      />
      <path
        d="M4.6 1.4h6.8L14.6 4.6"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.75"
        strokeWidth="0.9"
      />
      <path
        d="M1.4 11.4 4.6 14.6h6.8"
        fill="none"
        stroke="#000000"
        strokeOpacity="0.55"
        strokeWidth="0.9"
      />
      <rect x="4.5" y="7.1" width="7" height="1.8" rx="0.4" fill="#0b0b0c" />
      <rect x="4.5" y="8.5" width="7" height="0.5" rx="0.25" fill="#ffffff" opacity="0.3" />
    </svg>
  );
}
