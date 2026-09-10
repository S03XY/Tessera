-- ===========================================================================
-- The MCP layer.
--
-- Until now a listing was something an agent had to be *told* about: a human
-- read the docs, wrote a client, and hard-coded the slug. MCP inverts that.
-- The agent connects to one URL, asks what is available, and calls what it
-- finds — no integration step, no code change when the catalogue moves.
--
-- The design rule here is reuse, not replacement. Every MCP tool is backed by
-- an ordinary `services` row, so a tool call travels the same gateway, the
-- same metering, the same dispute window and the same HCS receipt as a direct
-- x402 call always has. This migration adds the *grouping* and the *shape*;
-- it does not add a second payment path.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A published MCP server.
--
-- One row per API a seller has handed us. It owns the URL an agent connects
-- to (/mcp/<slug>) and the provenance of the spec it was generated from, so a
-- regenerated server can be diffed against the one agents are already using.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_servers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       uuid        NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  slug            text        NOT NULL UNIQUE,
  name            text        NOT NULL,
  description     text        NOT NULL DEFAULT '',

  -- Provenance. spec_hash is sha256 of the document we actually parsed, not of
  -- the URL: a seller who silently edits their spec produces a different hash
  -- and the change is visible rather than inferred.
  spec_url        text,
  spec_hash       text,
  spec_version    text,

  -- Where the operations are called. Kept separate from the spec's own
  -- `servers[]` because a seller may host the spec somewhere other than the
  -- API, and because we must validate this against the SSRF rules once.
  base_url        text        NOT NULL,

  -- How the marketplace authenticates to the seller's upstream. The secret
  -- itself never lands here — only which mechanism to use and which env-scoped
  -- credential id to look up.
  auth_mode       text        NOT NULL DEFAULT 'none'
                    CHECK (auth_mode IN ('none','bearer','api_key_header','api_key_query')),
  auth_ref        text,
  auth_param      text,

  status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','suspended')),

  tool_count      int         NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_servers_seller_idx ON mcp_servers (seller_id);
CREATE INDEX mcp_servers_status_idx ON mcp_servers (status);

CREATE TRIGGER mcp_servers_touch BEFORE UPDATE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- A service can now be one tool of an MCP server.
--
-- Nullable throughout: every listing that exists today has no mcp_server_id
-- and keeps behaving exactly as it does now. A row with one is additionally
-- reachable as a tool, and is still reachable at /x402/<slug> directly.
-- ---------------------------------------------------------------------------
ALTER TABLE services ADD COLUMN mcp_server_id uuid REFERENCES mcp_servers(id) ON DELETE CASCADE;

-- The name the agent calls. Unique per server, because two tools with the same
-- name is a protocol error rather than a ranking problem.
ALTER TABLE services ADD COLUMN tool_name text;

-- The JSON Schema the agent sees. Shaped, not the raw OpenAPI parameter list:
-- see lib/openapi.ts for why an unshaped schema makes a tool unusable.
ALTER TABLE services ADD COLUMN input_schema jsonb;

-- Everything the executor needs to turn validated arguments into one HTTP
-- request: method, path template, and where each argument belongs
-- (path / query / header / body).
ALTER TABLE services ADD COLUMN mcp_operation jsonb;

-- Read-only, destructive, idempotent — surfaced to the agent as MCP tool
-- annotations so a client can require confirmation before a write.
ALTER TABLE services ADD COLUMN tool_annotations jsonb;

CREATE UNIQUE INDEX services_tool_name_idx ON services (mcp_server_id, tool_name)
  WHERE mcp_server_id IS NOT NULL;

CREATE INDEX services_mcp_server_idx ON services (mcp_server_id)
  WHERE mcp_server_id IS NOT NULL;

-- An openapi-backed listing is a third upstream kind. The existing CHECK
-- constrained http and graph_subgraph only, so it has to be restated rather
-- than added to.
ALTER TABLE services DROP CONSTRAINT services_upstream_shape;
ALTER TABLE services DROP CONSTRAINT services_upstream_kind_check;

ALTER TABLE services ADD CONSTRAINT services_upstream_kind_check
  CHECK (upstream_kind IN ('http','graph_subgraph','openapi'));

ALTER TABLE services ADD CONSTRAINT services_upstream_shape CHECK (
  (upstream_kind = 'http'           AND upstream_ref IS NULL     AND upstream_query IS NULL)
  OR
  (upstream_kind = 'graph_subgraph' AND upstream_ref IS NOT NULL AND upstream_query IS NOT NULL)
  OR
  -- An openapi row carries its operation blob and belongs to a server.
  (upstream_kind = 'openapi'        AND mcp_operation IS NOT NULL AND mcp_server_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Agent funding.
--
-- An MCP client cannot sign a Hedera transfer. Claude Desktop has no wallet,
-- and handing it one would mean this marketplace custodying a private key on
-- behalf of every buyer — which is worse, not better.
--
-- So an agent funds a balance once, from its own wallet, in a transaction we
-- can point at on HashScan. Each tool call draws that balance down, and the
-- marketplace signs the x402 leg to the seller. The agent's own caps and the
-- on-chain mandate both still gate the spend; this only changes *who holds the
-- key at the moment of settlement*, and the ledger below is what makes that
-- custody auditable rather than a promise.
-- ---------------------------------------------------------------------------
ALTER TABLE agents ADD COLUMN balance numeric(38,0) NOT NULL DEFAULT 0
  CHECK (balance >= 0);
ALTER TABLE agents ADD COLUMN asset text NOT NULL DEFAULT '0.0.0';
ALTER TABLE agents ADD COLUMN spent_total numeric(38,0) NOT NULL DEFAULT 0;

-- Append-only. Every movement of an agent's balance has a row here, and
-- balance_after is recorded at write time so the ledger can be replayed and
-- checked against `agents.balance` rather than trusted.
CREATE TABLE agent_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  kind          text        NOT NULL
                  CHECK (kind IN ('deposit','debit','refund','withdrawal','adjustment')),

  -- Always positive. `kind` carries the direction, so a stray sign cannot
  -- silently invert a debit into a credit.
  amount        numeric(38,0) NOT NULL CHECK (amount > 0),
  asset         text        NOT NULL DEFAULT '0.0.0',
  balance_after numeric(38,0) NOT NULL CHECK (balance_after >= 0),

  call_id       uuid        REFERENCES calls(id) ON DELETE SET NULL,

  -- The on-chain movement, when there was one. A debit against a prepaid
  -- balance has a settlement tx; an internal refund does not.
  tx            text,
  memo          text,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_ledger_agent_idx ON agent_ledger (agent_id, created_at DESC);
CREATE INDEX agent_ledger_call_idx  ON agent_ledger (call_id) WHERE call_id IS NOT NULL;

-- One deposit transaction may be credited exactly once. This is the same
-- replay guard `calls.payment_tx` provides on the selling side: without it a
-- resubmitted funding tx would credit the balance twice.
CREATE UNIQUE INDEX agent_ledger_tx_idx ON agent_ledger (tx)
  WHERE tx IS NOT NULL AND kind = 'deposit';

-- A tool call is attributable to the agent that made it. The column already
-- exists on calls; this records which MCP server it arrived through, so a
-- seller can tell MCP traffic from direct x402 traffic.
ALTER TABLE calls ADD COLUMN via text
  CHECK (via IS NULL OR via IN ('x402','mcp'));

CREATE INDEX calls_via_idx ON calls (via) WHERE via IS NOT NULL;
