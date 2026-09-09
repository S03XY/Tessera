import Link from "next/link";

/*
 * The base plate. Everything here is stencilled rather than typeset — this is
 * the strip of small print silk-screened onto the underside of a device, and
 * it should read as manufacturing marks, not as a marketing footer.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-black/60 bg-bg shadow-[inset_0_1px_0_var(--edge-hi)]">
      <div className="mx-auto max-w-[1240px] px-6 py-7 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-ink-4">
            Tessera · pay-per-call API marketplace
            <span aria-hidden="true" className="mx-2 text-ink-4">
              /
            </span>
            settled over x402 on Hedera
          </p>
          <nav className="flex items-center gap-5 font-mono text-[10.5px] uppercase tracking-[0.13em] text-ink-3">
            <Link href="/docs" className="transition-colors hover:text-ink">
              Docs
            </Link>
            <Link href="/docs/agent-api" className="transition-colors hover:text-ink">
              Agent API
            </Link>
            <a
              href="https://hashscan.io/testnet"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              HashScan ↗
            </a>
          </nav>
        </div>

        {/* Knurled strip: the grip along the bottom edge of the chassis. */}
        <div
          aria-hidden="true"
          className="knurl mt-5 h-2 rounded-none opacity-30 shadow-[inset_0_1px_1px_rgba(0,0,0,0.6)]"
        />
      </div>
    </footer>
  );
}
