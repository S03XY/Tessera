import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-bg">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-5 sm:px-8">
        <p className="text-[12px] text-ink-3">
          Tollgate · pay-per-call API marketplace settled over x402 on Hedera
        </p>
        <nav className="flex items-center gap-4 text-[12px] text-ink-3">
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
            HashScan
          </a>
        </nav>
      </div>
    </footer>
  );
}
