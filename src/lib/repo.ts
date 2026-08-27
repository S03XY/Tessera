import { query, queryOne } from "@/lib/db";
import { MIN_DEPOSIT_TINYBARS } from "@/lib/config";
import type { PriceUnit } from "@/lib/money";

/* -------------------------------------------------------------------- Types */

export interface SellerRow {
  id: string;
  account_id: string;
  display_name: string;
  contact_url: string | null;
  verification_status: "unverified" | "verified" | "revoked";
  verified_at: string | null;
  deposit_amount: string;
  deposit_asset: string;
  deposit_tx: string | null;
  calls_ok: string;
  calls_disputed: string;
  calls_refunded: string;
  created_at: string;
}

export interface ServiceRow {
  id: string;
  seller_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  endpoint_url: string;
  endpoint_method: "GET" | "POST";
  price_amount: string;
  price_unit: PriceUnit;
  asset: string;
  asset_decimals: number;
  status: "draft" | "active" | "suspended";
  onchain_service_id: string | null;
  register_tx: string | null;
  calls_ok: string;
  calls_failed: string;
  revenue_total: string;
  created_at: string;
}

/** A service joined with the seller fields the marketplace ranks and displays. */
export interface ServiceListing extends ServiceRow {
  seller_name: string;
  seller_account: string;
  seller_status: SellerRow["verification_status"];
  seller_deposit: string;
  success_rate: number | null;
}

export interface CallRow {
  id: string;
  service_id: string;
  agent_id: string | null;
  payer_account: string | null;
  quoted_amount: string;
  paid_amount: string | null;
  units: string | null;
  asset: string;
  payment_tx: string | null;
  request_hash: string | null;
  response_hash: string | null;
  status: "quoted" | "paid" | "delivered" | "failed" | "refunded";
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  hcs_receipt_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

/* ----------------------------------------------------------------- Selects */

const LISTING_SELECT = `
  SELECT s.*,
         sel.display_name        AS seller_name,
         sel.account_id          AS seller_account,
         sel.verification_status AS seller_status,
         sel.deposit_amount      AS seller_deposit,
         CASE WHEN (s.calls_ok + s.calls_failed) > 0
              THEN s.calls_ok::float / (s.calls_ok + s.calls_failed)
              ELSE NULL END      AS success_rate
    FROM services s
    JOIN sellers sel ON sel.id = s.seller_id`;

export interface DiscoverOptions {
  q?: string;
  category?: string;
  maxPrice?: string;
  unit?: PriceUnit;
  limit?: number;
  offset?: number;
  includeInactive?: boolean;
  /**
   * Hide listings the gateway would refuse anyway: unverified sellers and
   * sellers whose dispute deposit has fallen below the floor. Agents should
   * never be handed a listing they cannot actually buy.
   */
  payableOnly?: boolean;
}

/**
 * Capability search. Ranked by price ascending, then by observed success rate,
 * which is the order an agent optimising for cost actually wants.
 */
export async function discoverServices(
  options: DiscoverOptions = {},
): Promise<ServiceListing[]> {
  const {
    q,
    category,
    maxPrice,
    unit,
    includeInactive = false,
    payableOnly = false,
  } = options;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];

  if (!includeInactive) where.push(`s.status = 'active'`);

  if (payableOnly) {
    params.push(MIN_DEPOSIT_TINYBARS.toString());
    where.push(
      `sel.verification_status = 'verified' AND sel.deposit_amount >= $${params.length}::numeric`,
    );
  }

  if (q && q.trim()) {
    params.push(q.trim());
    const i = params.length;
    // websearch_to_tsquery tolerates the loose phrasing an agent will send.
    where.push(`(
      to_tsvector('english',
        service_search_text(s.name, s.description, s.category, s.keywords)
      ) @@ websearch_to_tsquery('english', $${i})
      OR s.name ILIKE '%' || $${i} || '%'
      OR s.category ILIKE '%' || $${i} || '%'
      OR EXISTS (SELECT 1 FROM unnest(s.keywords) k WHERE k ILIKE '%' || $${i} || '%')
    )`);
  }

  if (category && category.trim()) {
    params.push(category.trim());
    where.push(`s.category = $${params.length}`);
  }

  if (unit) {
    params.push(unit);
    where.push(`s.price_unit = $${params.length}`);
  }

  if (maxPrice && /^\d+$/.test(maxPrice)) {
    params.push(maxPrice);
    where.push(`s.price_amount <= $${params.length}::numeric`);
  }

  params.push(limit, offset);

  const sql = `${LISTING_SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY s.price_amount ASC,
             success_rate DESC NULLS LAST,
             s.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  return query<ServiceListing>(sql, params);
}

export async function countServices(options: DiscoverOptions = {}): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM services s
      ${options.includeInactive ? "" : "WHERE s.status = 'active'"}`,
  );
  return Number(row?.count ?? 0);
}

export async function getServiceBySlug(slug: string): Promise<ServiceListing | null> {
  return queryOne<ServiceListing>(`${LISTING_SELECT} WHERE s.slug = $1`, [slug]);
}

export async function getServiceById(id: string): Promise<ServiceListing | null> {
  if (!isUuid(id)) return null;
  return queryOne<ServiceListing>(`${LISTING_SELECT} WHERE s.id = $1`, [id]);
}

export async function listCategories(): Promise<Array<{ category: string; count: number }>> {
  const rows = await query<{ category: string; count: string }>(
    `SELECT category, count(*)::text AS count
       FROM services WHERE status = 'active'
      GROUP BY category ORDER BY count(*) DESC, category ASC`,
  );
  return rows.map((row) => ({ category: row.category, count: Number(row.count) }));
}

/* ----------------------------------------------------------------- Sellers */

export async function listSellers(): Promise<Array<SellerRow & { service_count: number }>> {
  const rows = await query<SellerRow & { service_count: string }>(
    `SELECT sel.*, count(s.id)::text AS service_count
       FROM sellers sel
       LEFT JOIN services s ON s.seller_id = sel.id AND s.status = 'active'
      GROUP BY sel.id
      ORDER BY sel.verification_status = 'verified' DESC,
               count(s.id) DESC,
               sel.created_at ASC`,
  );
  return rows.map((row) => ({ ...row, service_count: Number(row.service_count) }));
}

export async function getSellerByAccount(accountId: string): Promise<SellerRow | null> {
  return queryOne<SellerRow>(`SELECT * FROM sellers WHERE account_id = $1`, [accountId]);
}

export async function getSellerById(id: string): Promise<SellerRow | null> {
  if (!isUuid(id)) return null;
  return queryOne<SellerRow>(`SELECT * FROM sellers WHERE id = $1`, [id]);
}

export async function listServicesForSeller(sellerId: string): Promise<ServiceRow[]> {
  if (!isUuid(sellerId)) return [];
  return query<ServiceRow>(
    `SELECT * FROM services WHERE seller_id = $1 ORDER BY created_at DESC`,
    [sellerId],
  );
}

/* ------------------------------------------------------------------- Calls */

export async function recentCalls(limit = 25): Promise<Array<CallRow & {
  service_name: string;
  service_slug: string;
  seller_name: string;
}>> {
  return query(
    `SELECT c.*, s.name AS service_name, s.slug AS service_slug, sel.display_name AS seller_name
       FROM calls c
       JOIN services s   ON s.id = c.service_id
       JOIN sellers  sel ON sel.id = s.seller_id
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
}

export async function getCallById(id: string) {
  if (!isUuid(id)) return null;
  return queryOne<CallRow & { service_name: string; service_slug: string; seller_name: string }>(
    `SELECT c.*, s.name AS service_name, s.slug AS service_slug, sel.display_name AS seller_name
       FROM calls c
       JOIN services s   ON s.id = c.service_id
       JOIN sellers  sel ON sel.id = s.seller_id
      WHERE c.id = $1`,
    [id],
  );
}

/* ------------------------------------------------------------------ Totals */

export interface MarketStats {
  services: number;
  sellers: number;
  calls: number;
  settled: number;
  volume: string;
}

export async function marketStats(): Promise<MarketStats> {
  const row = await queryOne<{
    services: string;
    sellers: string;
    calls: string;
    settled: string;
    volume: string;
  }>(
    `SELECT
       (SELECT count(*) FROM services WHERE status = 'active')::text            AS services,
       (SELECT count(*) FROM sellers WHERE verification_status = 'verified')::text AS sellers,
       (SELECT count(*) FROM calls)::text                                        AS calls,
       (SELECT count(*) FROM calls WHERE status = 'delivered')::text             AS settled,
       (SELECT coalesce(sum(paid_amount), 0)::text FROM calls WHERE paid_amount IS NOT NULL) AS volume`,
  );

  return {
    services: Number(row?.services ?? 0),
    sellers: Number(row?.sellers ?? 0),
    calls: Number(row?.calls ?? 0),
    settled: Number(row?.settled ?? 0),
    volume: row?.volume ?? "0",
  };
}

/* ------------------------------------------------------------------ Shared */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
