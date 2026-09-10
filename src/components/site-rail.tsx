"use client";

import Link from "next/link";
import { useId } from "react";
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
  { href: "/mcp-servers", label: "MCP", n: "01" },
  { href: "/services", label: "Tools", n: "02" },
  { href: "/sellers", label: "Sellers", n: "03" },
  { href: "/activity", label: "Activity", n: "04" },
  { href: "/agent", label: "Agent", n: "05" },
  { href: "/onboarding", label: "Sell", n: "06" },
  { href: "/docs", label: "Docs", n: "07" },
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
 * The Tessera mark: a threshold cut to the shape of the token that opens it.
 *
 * The plate is a milled blank with its top-right corner chamfered off. The
 * passage through it is that same outline at half scale, rotated 180° — so its
 * chamfer falls on the opposite corner and the void is *keyed* to the plate,
 * one part in one orientation. That is the product in one shape: a token, and
 * the only gate it fits. It is also the app's actual architecture, not a
 * metaphor — the gateway is the single component every call passes through.
 *
 * The passage runs clean off the bottom edge rather than closing into a
 * counter. That is load-bearing, not stylistic: a closed counter fills in and
 * goes muddy at 16px, which is exactly how the previous mark died. An open
 * passage keeps two solid 4px legs and a 6px gap at favicon size, so the
 * silhouette survives being flattened to one flat fill on either polarity.
 *
 * Lighting follows the same law as every other part in the app. The plate is
 * raised, so the gradient carries a hard 1px white rail along its top edge and
 * a dark lip along its bottom; the 45° chamfer is the brightest face on the
 * object because it tilts up into the overhead source; and the passage is a
 * void, so it darkens toward its own top.
 */
export function TesseraMark({ className }: { className?: string }) {
  /*
   * Both the desktop spine and the mobile rail render this mark, so the two
   * live in the DOM at once. Namespacing the gradient ids keeps the second
   * instance from referencing the first one's defs.
   */
  const uid = useId().replace(/:/g, "");

  return (
    <svg viewBox="0 0 32 32" className={cx("shrink-0", className)} aria-hidden="true">
      <defs>
        {/*
          One gradient does three jobs via doubled stops: a 1px specular rail
          at the top edge, the body ramp, and a 1px shadow lip at the bottom.
        */}
        <linearGradient
          id={`tsr-face-${uid}`}
          x1="0"
          y1="2"
          x2="0"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.0357" stopColor="#ffffff" />
          <stop offset="0.0357" stopColor="#f4f4f1" />
          <stop offset="0.55" stopColor="#e2e2de" />
          <stop offset="0.9643" stopColor="#c4c4bf" />
          <stop offset="0.9643" stopColor="#2e2e31" />
          <stop offset="1" stopColor="#17171a" />
        </linearGradient>
        <linearGradient
          id={`tsr-void-${uid}`}
          x1="0"
          y1="10"
          x2="0"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#060607" />
          <stop offset="0.6" stopColor="#111114" />
          <stop offset="1" stopColor="#1c1c20" />
        </linearGradient>
        <linearGradient
          id={`tsr-cham-${uid}`}
          x1="0"
          y1="2"
          x2="0"
          y2="16"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eeeeea" />
        </linearGradient>
      </defs>

      {/* The passage, sunk behind the plate. */}
      <path fill={`url(#tsr-void-${uid})`} d="M10 30V16L16 10H22V30Z" />
      {/* The plate, with the passage knocked out of it. */}
      <path
        fill={`url(#tsr-face-${uid})`}
        fillRule="evenodd"
        d="M2 2H22L30 10V30H2ZM10 30V16L16 10H22V30Z"
      />
      {/* The chamfered face, tilted up into the light. */}
      <path fill={`url(#tsr-cham-${uid})`} d="M22 2L30 10V16L16 2Z" />
    </svg>
  );
}
