import * as React from "react";
import {
  credentialLabel,
  REAL_CREDENTIALS,
  SIMULATED_CREDENTIAL,
} from "@/lib/world-credentials";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

/*
 * Buttons are keys on a faceplate. Pressing one seats it into the panel: it
 * travels 1px, its top highlight goes out, and the shadow beneath it closes
 * up. That three-part change is what makes a press feel mechanical rather
 * than like an opacity flicker.
 */
const BUTTON_BASE =
  "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap " +
  "rounded-full font-medium tracking-[-0.005em] " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-100 " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  /* Bright turned aluminium. One per screen — see globals.css. */
  primary:
    "machined-bright brushed struck font-semibold " +
    "hover:brightness-[1.06] " +
    "active:translate-y-px active:shadow-[inset_0_2px_3px_rgba(0,0,0,0.32),0_0_0_1px_rgba(0,0,0,0.5)] " +
    "disabled:active:translate-y-0",
  /* Dark anodised key. */
  secondary:
    "machined brushed text-ink " +
    "hover:brightness-125 " +
    "active:translate-y-px active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.8)] " +
    "disabled:active:translate-y-0",
  /* No part at all — just a label cut into the panel. */
  ghost:
    "border border-transparent text-ink-3 hover:bg-[rgba(255,255,255,0.045)] hover:text-ink " +
    "active:translate-y-px disabled:active:translate-y-0",
  /*
   * Destructive reads as a hazard placard: hatched machining marks, a hard
   * bright border. With no red available, texture has to do the warning.
   */
  danger:
    "hatched border border-line-3 bg-bg-inset text-ink " +
    "shadow-[inset_0_1px_0_var(--edge-hi),0_1px_2px_rgba(0,0,0,0.6)] " +
    "hover:border-[rgba(255,255,255,0.42)] hover:bg-[rgba(255,255,255,0.06)] " +
    "active:translate-y-px active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.8)] " +
    "disabled:active:translate-y-0",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-3.5 text-[12.5px]",
  md: "h-9 px-5 text-[13px]",
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
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.6" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------- Lamp */

/**
 * The indicator lamp. Brightness is the signal: lit is on, dim is idle, and
 * a ring means the state is unresolved. Every use is paired with a text
 * label, because luminance alone must never be the only carrier of meaning.
 */
export function Lamp({
  state = "on",
  live = false,
  className,
}: {
  state?: "on" | "idle" | "off";
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "size-1.5 shrink-0 rounded-full",
        state === "on" && "bg-ink shadow-[0_0_5px_rgba(255,255,255,0.55)]",
        state === "idle" && "border border-ink-3 bg-transparent",
        state === "off" && "bg-ink-4/50",
        live && "animate-lamp",
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------- Panel */

/**
 * A section of the block. Flat and matte — panels hold content, they are not
 * themselves parts, so they get no bevel. Only controls get bevels.
 */
export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cx("matte seat-in rounded-none", className)}>
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
        "scribe flex flex-wrap items-start justify-between gap-3 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.11em] text-ink-2">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A stencilled label for sections that are not panels. Mono, letterspaced,
 * cut into the surface — the way a legend is printed on equipment.
 */
export function Legend({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cx(
        "engraved font-mono text-[11px] font-medium uppercase tracking-[0.13em]",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * A section whose label lives in the left margin rather than above its
 * content — the way a heading is set in a technical manual.
 *
 * Two things fall out of it that a stacked heading cannot do: the content
 * column starts at the same x-position on every section, so the page has one
 * spine instead of a ragged stack; and the label can stay put while a long
 * section scrolls past it, so you always know what you are looking at. Below
 * `lg` it folds back to a stacked label, because a 200px margin is most of a
 * phone.
 */
export function MarginSection({
  legend,
  note,
  children,
  className,
}: {
  legend: string;
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "grid gap-x-10 gap-y-5 lg:grid-cols-[190px_minmax(0,1fr)]",
        className,
      )}
    >
      <div className="seat-in lg:sticky lg:top-12 lg:self-start lg:pt-1">
        <Legend>{legend}</Legend>
        {note && (
          <p className="mt-3 max-w-[210px] text-[12px] leading-relaxed text-ink-4">
            {note}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * A full-bleed band of the wordmark at display scale, used as the divider
 * between major sections instead of another hairline rule.
 *
 * It is the one place in the app where the polarity flips: bright metal
 * ground, dark text struck into it. In a system with no colour, inverting a
 * whole band is the loudest punctuation available, so it happens once per
 * page and never twice.
 */
export function MarqueeBand({
  words = ["Tessera", "Pay per call", "x402", "Hedera"],
  className,
}: {
  words?: string[];
  className?: string;
}) {
  const run = (hidden: boolean) => (
    <div aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {words.map((word) => (
        <span key={word} className="flex items-center">
          <span className="struck px-6 text-[clamp(3.25rem,8vw,7.5rem)] font-semibold leading-none tracking-[-0.045em] text-bg">
            {word}
          </span>
          <span aria-hidden="true" className="text-[clamp(1rem,2vw,2rem)] leading-none text-bg/45">
            ✦
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      className={cx(
        "machined-bright brushed relative overflow-hidden border-y border-black/55 py-5",
        className,
      )}
    >
      <div className="animate-marquee flex w-max items-center">
        {run(false)}
        {/* The second run exists only so the wrap is seamless. */}
        {run(true)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Badge */

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

/*
 * State without hue. Each tone is a different physical treatment, so the
 * three that matter stay distinguishable in greyscale, under colour-blindness
 * and on a washed-out projector:
 *
 *   ok      dark chip, lamp lit          — settled, verified, delivered
 *   warn    dark chip, machining hatch   — pending, unverified, open
 *   bad     inverted bright plate        — failed, refunded, revoked
 *
 * The inversion on `bad` is deliberate and is the loudest object available in
 * a monochrome system; it is spent only on outcomes the user must not miss.
 */
const TONE: Record<Tone, string> = {
  neutral: "border-line-2 bg-bg-sunken text-ink-3",
  accent: "border-line-3 bg-[rgba(255,255,255,0.07)] text-ink",
  ok: "border-line-3 bg-[rgba(255,255,255,0.055)] text-ink",
  warn: "hatched border-line-2 bg-bg-sunken text-ink-2",
  bad: "border-transparent bg-ink text-bg struck font-semibold",
};

const TONE_LAMP: Record<Tone, "on" | "idle" | "off"> = {
  neutral: "off",
  accent: "on",
  ok: "on",
  warn: "idle",
  bad: "off",
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
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-px",
        "font-mono text-[11px] font-medium uppercase leading-[17px] tracking-[0.07em]",
        TONE[tone],
        className,
      )}
    >
      {dot &&
        (tone === "bad" ? (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-bg" />
        ) : (
          <Lamp state={TONE_LAMP[tone]} />
        ))}
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
      className={cx("font-mono text-[12px] tracking-[-0.01em] text-ink-2", className)}
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
    <div className={cx("divide-y divide-line", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-1/3 opacity-70" />
          <Skeleton className="ml-auto h-3 w-16 opacity-50" />
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
      className={cx("bar-indeterminate h-0.5 w-full", className)}
    >
      <div
        className="h-full w-1/4 bg-ink"
        style={{ animation: "tg-indeterminate 1.1s var(--ease-mech) infinite" }}
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
    <div className={cx("animate-fade-in px-6 py-14 text-center", className)}>
      {/* An empty bay in the panel, milled but unoccupied. */}
      <div
        aria-hidden="true"
        className="knurl mx-auto mb-4 h-8 w-16 rounded-none opacity-40 shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)]"
      />
      <p className="text-[13px] font-medium text-ink">{title}</p>
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
    <div className="scroll-thin w-full min-w-0 max-w-full overflow-x-auto">
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
        "scribe bg-bg-sunken px-4 py-2 font-mono text-[10.5px] font-medium uppercase",
        "tracking-[0.13em] text-ink-4",
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
      <label
        htmlFor={htmlFor}
        className="block font-mono text-[10.5px] font-medium uppercase tracking-[0.13em] text-ink-3"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1.5 text-[12px] font-medium text-ink">
          <span aria-hidden="true" className="mt-px font-mono">
            ✕
          </span>
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] leading-relaxed text-ink-4">{hint}</p>
      ) : null}
    </div>
  );
}

/*
 * Inputs are wells: material removed from the panel, so text sits *in* the
 * surface. Focus does not add a coloured ring — it lights the cut, the way a
 * recess catches light when it is the live one.
 */
const CONTROL =
  "well w-full rounded-none px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-4 " +
  "transition-[box-shadow,background-color] duration-150 " +
  "hover:bg-[#0b0b0d] " +
  "focus:bg-[#0b0b0d] focus:outline-none " +
  "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.8),inset_0_0_0_1px_rgba(255,255,255,0.34)] " +
  "disabled:text-ink-4 disabled:opacity-60";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, "h-8.5", className)} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, "min-h-20 resize-y", className)} />;
}

/*
 * The native select paints its own raised background, which reads as a bump
 * on a panel of recessed wells. Stripping the appearance and drawing the
 * chevron ourselves is the only way to keep it in the same material.
 */
const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239a9a98' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        appearance: "none",
        backgroundImage: SELECT_CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
        ...props.style,
      }}
      className={cx(CONTROL, "h-8.5 cursor-pointer pr-8", className)}
    />
  );
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
    <div
      className={cx(
        "mx-auto w-full max-w-[1240px] px-6 py-11 sm:px-10 lg:py-16",
        className,
      )}
    >
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
    <header className="animate-seat mb-9">
      <div className="grid gap-x-10 gap-y-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end">
        <div className="min-w-0">
          {eyebrow && <Legend className="mb-3">{eyebrow}</Legend>}
          <h1 className="text-[clamp(2.25rem,4.4vw,3.5rem)] font-semibold leading-[0.98] tracking-[-0.038em] text-ink">
            {title}
          </h1>
        </div>
        <div className="min-w-0 lg:pb-2">
          {description && (
            <p className="text-[13px] leading-relaxed text-ink-3">{description}</p>
          )}
          {actions && (
            <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      </div>
      {/* The seam between the masthead and the body, drawn as you reach it. */}
      <div aria-hidden="true" className="scribe scribe-in mt-8" />
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
  /*
   * Callouts carry their tone on a thick left edge — a painted stripe on the
   * side of a chassis. Cautions add machining hatch; the destructive tone
   * gets a bright edge that reads at a glance across the page.
   */
  const edge: Record<Tone, string> = {
    neutral: "border-l-line-3 bg-bg-sunken",
    accent: "border-l-ink bg-[rgba(255,255,255,0.045)]",
    ok: "border-l-ink bg-[rgba(255,255,255,0.035)]",
    warn: "hatched border-l-ink-3 bg-bg-sunken",
    bad: "border-l-ink bg-[rgba(255,255,255,0.07)]",
  };
  return (
    <div
      className={cx(
        "rounded-none border border-line border-l-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed",
        edge[tone],
      )}
    >
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
          <dt className="font-mono text-[11px] uppercase tracking-[0.09em] text-ink-4">
            {item.label}
          </dt>
          <dd className="tnum min-w-0 text-right text-[13px] text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A single figure on a faceplate: the number cut large in mono, the legend
 * stencilled beneath it. Readings are always mono — a human did not write
 * them, the machine did.
 */
export function Readout({
  label,
  value,
  suffix,
  className,
}: {
  label: string;
  value: React.ReactNode;
  suffix?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0 px-4 py-3.5", className)}>
      <p className="tnum flex items-baseline gap-1 font-mono text-[19px] font-medium tracking-[-0.02em] text-ink">
        <span className="truncate">{value}</span>
        {suffix && <span className="text-[12px] font-normal text-ink-4">{suffix}</span>}
      </p>
      <Legend className="mt-1.5 text-[10px]">{label}</Legend>
    </div>
  );
}

/** Small filled tick used next to a World-verified seller name. */
export function VerifiedTick({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      className={cx("size-3.5 shrink-0 text-ink", className)}
      role="img"
      aria-label="Passed the seller gate"
    >
      <circle cx="7" cy="7" r="6.2" fill="currentColor" opacity="0.16" />
      <circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" strokeOpacity="0.4" />
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

/**
 * Only a credential this app itself obtained from World counts as verified.
 * Everything else — the simulation, seeded demo fixtures, anything
 * unrecognised — is labelled, because the alternative is a badge claiming a
 * verification that never happened.
 *
 * The allowlist is the credential registry itself, so it fails closed: a
 * value that is not a credential we can actually request reads as unverified
 * rather than silently inheriting the real badge. The badge names whichever
 * credential the seller actually holds — a seller who passed an Orb check
 * should not be described as having passed Selfie Check.
 */
export function VerificationBadge({ credential }: { credential: string | null }) {
  if (credential && REAL_CREDENTIALS.has(credential)) {
    return (
      <Badge tone="ok" dot>
        {credentialLabel(credential)}
      </Badge>
    );
  }
  return (
    <Badge tone="warn" dot>
      {credential === SIMULATED_CREDENTIAL ? "World ID · simulated" : "World ID · demo fixture"}
    </Badge>
  );
}
