import * as React from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium " +
  "transition-[background-color,border-color,color,box-shadow] duration-150 " +
  "disabled:cursor-not-allowed disabled:opacity-45";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-ink bg-ink text-white hover:bg-[#25282e] hover:border-[#25282e] active:bg-[#0f1013]",
  secondary:
    "border-line-2 bg-bg text-ink hover:bg-bg-subtle hover:border-line-3 active:bg-bg-sunken",
  ghost:
    "border-transparent bg-transparent text-ink-2 hover:bg-bg-sunken hover:text-ink",
  danger:
    "border-bad bg-bad text-white hover:bg-[#9d1f15] hover:border-[#9d1f15]",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-[13.5px]",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- Spinner */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx("animate-spin-slow size-4 shrink-0", className)}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------- Panel */

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cx(
        "rounded-lg border border-line bg-bg shadow-[0_1px_2px_rgba(16,18,22,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-medium text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Badge */

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

const TONE: Record<Tone, string> = {
  neutral: "border-line-2 bg-bg-sunken text-ink-2",
  accent: "border-accent-line bg-accent-soft text-accent",
  ok: "border-ok-line bg-ok-soft text-ok",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-5",
        TONE[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  active: "ok",
  verified: "ok",
  delivered: "ok",
  paid: "ok",
  upheld: "ok",
  issued: "ok",
  draft: "neutral",
  quoted: "neutral",
  unverified: "warn",
  open: "warn",
  suspended: "warn",
  failed: "bad",
  refunded: "bad",
  revoked: "bad",
  rejected: "bad",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/* -------------------------------------------------------------------- Mono */

export function Mono({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx("font-mono text-[12px] tracking-tight text-ink-2", className)}
    >
      {children}
    </span>
  );
}

/** Middle-truncates a long identifier so both ends stay readable. */
export function truncateMiddle(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/* ---------------------------------------------------------------- Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("skeleton h-4 w-full", className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-px", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-3.5 w-1/4" />
          <Skeleton className="h-3.5 w-1/3 opacity-70" />
          <Skeleton className="ml-auto h-3.5 w-16 opacity-50" />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Progress */

/** Indeterminate bar for work with no measurable percentage. */
export function IndeterminateBar({ className }: { className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label="Working"
      className={cx("bar-indeterminate h-0.5 w-full rounded-full", className)}
    >
      <div
        className="h-full w-1/4 rounded-full bg-accent"
        style={{ animation: "tg-indeterminate 1.1s var(--ease-in-out-soft) infinite" }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- Empty state */

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("px-6 py-14 text-center animate-fade-in", className)}>
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      {description && (
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-ink-3">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Table */

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto scroll-thin">
      <table className={cx("w-full min-w-[640px] border-collapse text-left", className)}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = "left",
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-line bg-bg-subtle px-4 py-2 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cx(
        "border-b border-line px-4 py-2.5 align-middle text-[13px] text-ink-2",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------- Forms */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-[12.5px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-bad">{error}</p>
      ) : hint ? (
        <p className="text-[12px] leading-relaxed text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[13px] text-ink " +
  "placeholder:text-ink-4 transition-colors duration-150 " +
  "hover:border-line-3 focus:border-accent focus:outline-none " +
  "focus:ring-[3px] focus:ring-accent/12 disabled:bg-bg-sunken disabled:text-ink-3";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, "h-9", className)} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, "min-h-20 resize-y", className)} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(CONTROL, "h-9 pr-8", className)} />;
}

/* -------------------------------------------------------------- Page shell */

export function Page({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-auto w-full max-w-[1120px] px-5 py-8 sm:px-8", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.07em] text-ink-3">
            {eyebrow}
          </p>
        )}
        <h1 className="text-[26px] font-[560] tracking-[-0.02em] text-ink">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/* -------------------------------------------------------------------- Misc */

export function Callout({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  const border: Record<Tone, string> = {
    neutral: "border-line bg-bg-subtle",
    accent: "border-accent-line bg-accent-soft",
    ok: "border-ok-line bg-ok-soft",
    warn: "border-warn-line bg-warn-soft",
    bad: "border-bad-line bg-bad-soft",
  };
  return (
    <div className={cx("rounded-md border px-3.5 py-3 text-[12.5px] leading-relaxed", border[tone])}>
      {title && <p className="mb-0.5 font-medium text-ink">{title}</p>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

export function KeyValue({
  items,
  className,
}: {
  items: Array<{ label: string; value: React.ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={cx("divide-y divide-line", className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <dt className="text-[12.5px] text-ink-3">{item.label}</dt>
          <dd className="min-w-0 text-right text-[13px] text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small filled tick used next to a World-verified seller name. */
export function VerifiedTick({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      className={cx("size-3.5 shrink-0 text-ok", className)}
      role="img"
      aria-label="Verified seller"
    >
      <circle cx="7" cy="7" r="6.2" fill="currentColor" opacity="0.14" />
      <path
        d="M4.4 7.2 6.2 9l3.4-3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Simulated Selfie Check passes must never render as the real thing. */
export const SIMULATED_CREDENTIAL = "selfie_check_simulated";

export function VerificationBadge({ credential }: { credential: string | null }) {
  if (credential === SIMULATED_CREDENTIAL) {
    return (
      <Badge tone="warn" dot>
        Selfie Check (simulated)
      </Badge>
    );
  }
  return (
    <Badge tone="ok" dot>
      Selfie Check
    </Badge>
  );
}
