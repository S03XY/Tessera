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
  // Adjusting state during render is React's documented alternative to
  // setState-in-effect: it re-renders before paint instead of cascading.
  const [syncedQuery, setSyncedQuery] = useState(defaultQuery);
  if (defaultQuery !== syncedQuery) {
    setSyncedQuery(defaultQuery);
    setValue(defaultQuery);
  }

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
    <div className="matte rounded-none">
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon />
          <input
            type="search"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search a capability — “exchange rates”, “weather”, “bitcoin price”"
            aria-label="Search services by capability"
            className={cx(
              "well h-8.5 w-full rounded-none pl-8 pr-8 text-[13px] text-ink",
              "placeholder:text-ink-4 transition-[box-shadow,background-color] duration-150",
              "hover:bg-[#0b0b0d] focus:bg-[#0b0b0d] focus:outline-none",
              "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_0_0_1px_rgba(255,255,255,0.34)]",
            )}
          />
          {pending && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3">
              <Spinner className="size-3.5" />
            </span>
          )}
        </div>

        {/* Wrapped rather than width-overridden: `w-auto` and the control's
            own `w-full` are the same specificity, so which one wins depends on
            stylesheet order, not class order. */}
        <div className="w-[150px] shrink-0">
          <Select
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            aria-label="Filter by metering unit"
          >
            <option value="">Any metering</option>
            <option value="per_call">Per call</option>
            <option value="per_token">Per token</option>
            <option value="per_row">Per row</option>
          </Select>
        </div>

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
      {pending && <IndeterminateBar className="rounded-none" />}
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
