"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, IndeterminateBar, Select, Spinner, cx } from "@/components/ui";

/**
 * Debounced capability search. The URL stays the source of truth so a search
 * result is linkable and the server component re-renders with fresh rows.
 */
export function ServiceSearch({
  defaultQuery,
  defaultUnit,
  category,
}: {
  defaultQuery: string;
  defaultUnit: string;
  category: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(defaultQuery);
  const [unit, setUnit] = useState(defaultUnit);
  const first = useRef(true);

  // Keep the field in sync when the user navigates back to a prior search.
  useEffect(() => setValue(defaultQuery), [defaultQuery]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (value.trim()) params.set("q", value.trim());
      if (category) params.set("category", category);
      if (unit) params.set("unit", unit);
      const qs = params.toString();
      startTransition(() => router.replace(qs ? `/services?${qs}` : "/services"));
    }, 280);
    return () => clearTimeout(timer);
  }, [value, unit, category, router]);

  return (
    <div className="rounded-lg border border-line bg-bg">
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-0 flex-1">
          <SearchIcon />
          <input
            type="search"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search a capability — “exchange rates”, “weather”, “bitcoin price”"
            aria-label="Search services by capability"
            className={cx(
              "h-9 w-full rounded-md border border-line-2 bg-bg pl-8 pr-8 text-[13px] text-ink",
              "placeholder:text-ink-4 transition-colors duration-150",
              "hover:border-line-3 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/12",
            )}
          />
          {pending && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3">
              <Spinner className="size-3.5" />
            </span>
          )}
        </div>

        <Select
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          aria-label="Filter by metering unit"
          className="h-9 w-auto min-w-[132px]"
        >
          <option value="">Any metering</option>
          <option value="per_call">Per call</option>
          <option value="per_token">Per token</option>
          <option value="per_row">Per row</option>
        </Select>

        {(value || unit) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue("");
              setUnit("");
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {pending && <IndeterminateBar className="rounded-none rounded-b-lg" />}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4"
    >
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
