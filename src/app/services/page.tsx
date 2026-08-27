import Link from "next/link";
import { Suspense } from "react";
import { discoverServices, listCategories } from "@/lib/repo";
import { formatAmount, isPriceUnit, PRICE_UNIT_LABEL } from "@/lib/money";
import {
  Badge,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonRows,
  Table,
  Td,
  Th,
  VerifiedTick,
  cx,
} from "@/components/ui";
import { ServiceSearch } from "./search";

export const dynamic = "force-dynamic";

export const metadata = { title: "Services" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const q = one(params.q) ?? "";
  const category = one(params.category) ?? "";
  const unitParam = one(params.unit);
  const unit = isPriceUnit(unitParam) ? unitParam : undefined;

  return (
    <Page>
      <PageHeader
        eyebrow="Discovery"
        title="Services"
        description="Every listing is a live HTTP endpoint behind the x402 gateway. Prices are per metering unit, quoted in HBAR at request time."
      />

      <Suspense fallback={null}>
        <CategoryBar active={category} q={q} />
      </Suspense>

      <div className="mt-4">
        <ServiceSearch defaultQuery={q} defaultUnit={unit ?? ""} category={category} />
      </div>

      <div className="mt-4">
        <Suspense key={`${q}|${category}|${unit}`} fallback={<ResultsSkeleton />}>
          <Results q={q} category={category} unit={unit} />
        </Suspense>
      </div>
    </Page>
  );
}

async function CategoryBar({ active, q }: { active: string; q: string }) {
  const categories = await listCategories();
  if (categories.length === 0) return null;

  const href = (value: string) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (value) search.set("category", value);
    const qs = search.toString();
    return qs ? `/services?${qs}` : "/services";
  };

  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Categories">
      <Link
        href={href("")}
        className={cx(
          "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
          active === ""
            ? "border-ink bg-ink text-white"
            : "border-line-2 bg-bg text-ink-2 hover:border-line-3 hover:text-ink",
        )}
      >
        All
      </Link>
      {categories.map((item) => (
        <Link
          key={item.category}
          href={href(item.category)}
          className={cx(
            "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            active === item.category
              ? "border-ink bg-ink text-white"
              : "border-line-2 bg-bg text-ink-2 hover:border-line-3 hover:text-ink",
          )}
        >
          {item.category}
          <span className="ml-1.5 text-[11px] opacity-55">{item.count}</span>
        </Link>
      ))}
    </nav>
  );
}

async function Results({
  q,
  category,
  unit,
}: {
  q: string;
  category: string;
  unit?: "per_call" | "per_token" | "per_row";
}) {
  const services = await discoverServices({ q, category, unit, limit: 100 });

  if (services.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No services match that search"
          description={
            q
              ? `Nothing indexed for “${q}”. Try a broader capability word such as “rates”, “weather” or “price”.`
              : "No active listings yet. Seed the demo sellers with npm run db:seed."
          }
        />
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={`${services.length} service${services.length === 1 ? "" : "s"}`}
        description="Sorted by price ascending, then success rate."
      />
      <Table>
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>Seller</Th>
            <Th>Metering</Th>
            <Th align="right">Success</Th>
            <Th align="right">Price</Th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => (
            <tr key={service.id} className="group transition-colors hover:bg-bg-subtle">
              <Td>
                <Link
                  href={`/services/${service.slug}`}
                  className="font-medium text-ink underline-offset-4 group-hover:underline"
                >
                  {service.name}
                </Link>
                <p className="mt-0.5 line-clamp-1 max-w-md text-[12px] text-ink-3">
                  {service.description}
                </p>
              </Td>
              <Td>
                <div className="flex items-center gap-1.5">
                  <Link
                    href={`/sellers/${service.seller_account}`}
                    className="text-[12.5px] text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                  >
                    {service.seller_name}
                  </Link>
                  {service.seller_status === "verified" && <VerifiedTick />}
                </div>
              </Td>
              <Td>
                <Badge tone="neutral">per {PRICE_UNIT_LABEL[service.price_unit]}</Badge>
              </Td>
              <Td align="right">
                {service.success_rate === null ? (
                  <span className="text-[12px] text-ink-4">—</span>
                ) : (
                  <span className="tnum font-mono text-[12.5px]">
                    {(service.success_rate * 100).toFixed(0)}%
                  </span>
                )}
              </Td>
              <Td align="right">
                <span className="tnum font-mono text-[12.5px] text-ink">
                  {formatAmount(service.price_amount, service.asset_decimals)} ℏ
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function ResultsSkeleton() {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Loading services" />
      <SkeletonRows rows={7} />
    </Panel>
  );
}
