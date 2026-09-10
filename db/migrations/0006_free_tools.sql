-- ===========================================================================
-- Free tools.
--
-- The product is a marketplace of MCP servers, not of APIs, and a server is a
-- set of tools rather than one priced thing. A seller decides tool by tool:
-- all free, all paid, or — the interesting case — a free tool that lets an
-- agent look around and a paid one that does the expensive work.
--
-- The schema forbade that outright: `price_amount > 0` meant a listing could
-- not be free, so the whole free tier was unrepresentable. Relaxing it to >= 0
-- is the smallest change that makes the product's actual pricing model
-- expressible, and 0 is a real price rather than a sentinel — a free call
-- still creates a `calls` row, still records a response hash, and is still
-- covered by the seller's dispute deposit.
-- ===========================================================================

ALTER TABLE services DROP CONSTRAINT services_price_amount_check;

ALTER TABLE services ADD CONSTRAINT services_price_amount_check
  CHECK (price_amount >= 0);

COMMENT ON COLUMN services.price_amount IS
  'Atomic units per unit of the price_unit. Zero means the tool is free: it is '
  'delivered without a payment leg, and calls to it are recorded with '
  'paid_amount 0 rather than being skipped.';

-- A free call has no payment, so `payment_tx` stays null and the unique index
-- on it (the replay guard) is unaffected — it is already partial on NOT NULL.

-- Whether a whole server is free, mixed, or entirely paid is derived rather
-- than stored, so it can never disagree with the tools themselves.
CREATE OR REPLACE VIEW mcp_server_pricing AS
  SELECT ms.id            AS server_id,
         count(s.id)                                    AS tool_count,
         count(s.id) FILTER (WHERE s.price_amount = 0)   AS free_count,
         count(s.id) FILTER (WHERE s.price_amount > 0)   AS paid_count,
         min(NULLIF(s.price_amount, 0))                  AS min_paid_price,
         max(s.price_amount)                             AS max_price
    FROM mcp_servers ms
    LEFT JOIN services s
      ON s.mcp_server_id = ms.id AND s.status = 'active'
   GROUP BY ms.id;
