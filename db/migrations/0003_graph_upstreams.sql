-- ===========================================================================
-- Graph-backed listings.
--
-- Until now every listing wrapped a plain HTTP endpoint. A subgraph is not a
-- URL you can GET: it is a subgraph id plus a GraphQL document, executed
-- against The Graph's gateway with the marketplace's own key. So the delivery
-- step needs to know which kind of upstream it is talking to.
--
-- `upstream_kind` defaults to 'http', which is exactly what every existing row
-- already is — this migration cannot change the behaviour of a single seeded
-- listing.
-- ===========================================================================

ALTER TABLE services
  ADD COLUMN upstream_kind text NOT NULL DEFAULT 'http'
    CHECK (upstream_kind IN ('http', 'graph_subgraph'));

-- For graph_subgraph rows: the subgraph id the gateway routes to, and the
-- GraphQL document executed against it. endpoint_url stays NOT NULL upstream,
-- so a graph listing stores its gateway URL there for display and keeps the
-- routing identity here.
ALTER TABLE services ADD COLUMN upstream_ref   text;
ALTER TABLE services ADD COLUMN upstream_query text;

-- Which standardized schema family this subgraph implements, when it does.
-- The Graph's "composable / standardized schemas" story is exactly this: one
-- query shape answered by ninety deployments across fifteen chains.
ALTER TABLE services ADD COLUMN upstream_schema text;
ALTER TABLE services ADD COLUMN upstream_chain  text;

-- A graph listing must carry the two things the gateway needs, and a plain
-- http listing must not pretend to.
ALTER TABLE services ADD CONSTRAINT services_upstream_shape CHECK (
  (upstream_kind = 'http'           AND upstream_ref IS NULL     AND upstream_query IS NULL)
  OR
  (upstream_kind = 'graph_subgraph' AND upstream_ref IS NOT NULL AND upstream_query IS NOT NULL)
);

CREATE INDEX services_upstream_kind_idx ON services (upstream_kind);

-- ---------------------------------------------------------------------------
-- The second leg of the purchase.
--
-- A Graph-backed call is two payments, not one: the buyer pays Tollgate in
-- HBAR on Hedera, and Tollgate pays The Graph in USDC on Base. Both belong on
-- the call row, next to each other, or the receipt only tells half the story.
--
-- upstream_cost_atomic is USDC base units (6 decimals) — an integer, never a
-- float, for the same reason every other amount in this schema is.
-- ---------------------------------------------------------------------------
ALTER TABLE calls ADD COLUMN upstream_kind        text;
ALTER TABLE calls ADD COLUMN upstream_ref         text;
ALTER TABLE calls ADD COLUMN upstream_cost_atomic numeric(38,0);
ALTER TABLE calls ADD COLUMN upstream_cost_asset  text;
ALTER TABLE calls ADD COLUMN upstream_network     text;
ALTER TABLE calls ADD COLUMN upstream_tx          text;

CREATE INDEX calls_upstream_kind_idx ON calls (upstream_kind)
  WHERE upstream_kind IS NOT NULL;
