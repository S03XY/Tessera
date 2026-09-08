-- ===========================================================================
-- Tessera — initial schema.
--
-- Source-of-truth rule: the chain is authoritative for every value transfer.
-- Postgres is a read model. Any column holding an amount that moved must sit
-- next to the tx hash that moved it, hence the *_tx columns throughout.
-- ===========================================================================

CREATE TABLE sellers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          text        NOT NULL UNIQUE,          -- Hedera account, e.g. 0.0.12345
  display_name        text        NOT NULL,
  contact_url         text,

  -- World ID Selfie Check. nullifier_hash is unique so one human cannot
  -- register as many sellers, which is the whole point of the gate.
  verification_status text        NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','verified','revoked')),
  verified_at         timestamptz,
  world_nullifier     text UNIQUE,
  world_credential    text,

  -- Refundable deposit backing every dispute this seller can lose.
  deposit_amount      numeric(38,0) NOT NULL DEFAULT 0,
  deposit_asset       text        NOT NULL DEFAULT '0.0.0',
  deposit_tx          text,

  calls_ok            bigint      NOT NULL DEFAULT 0,
  calls_disputed      bigint      NOT NULL DEFAULT 0,
  calls_refunded      bigint      NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid        NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  slug                text        NOT NULL UNIQUE,
  name                text        NOT NULL,
  description         text        NOT NULL DEFAULT '',
  category            text        NOT NULL DEFAULT 'general',

  -- Never exposed to buyers: the gateway is the only thing that calls it.
  endpoint_url        text        NOT NULL,
  endpoint_method     text        NOT NULL DEFAULT 'GET'
                        CHECK (endpoint_method IN ('GET','POST')),

  price_amount        numeric(38,0) NOT NULL CHECK (price_amount > 0),
  price_unit          text        NOT NULL DEFAULT 'per_call'
                        CHECK (price_unit IN ('per_call','per_token','per_row')),
  asset               text        NOT NULL DEFAULT '0.0.0',
  asset_decimals      int         NOT NULL DEFAULT 8,

  status              text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','suspended')),

  onchain_service_id  text,
  register_tx         text,

  calls_ok            bigint      NOT NULL DEFAULT 0,
  calls_failed        bigint      NOT NULL DEFAULT 0,
  revenue_total       numeric(38,0) NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_seller_idx   ON services (seller_id);
CREATE INDEX services_status_idx   ON services (status);
CREATE INDEX services_category_idx ON services (category);

-- Free-text discovery. Agents search by capability ("gold price"), not by name.
CREATE INDEX services_search_idx ON services
  USING gin (to_tsvector('english', name || ' ' || description || ' ' || category));

CREATE TABLE agents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label               text        NOT NULL,
  owner_account       text        NOT NULL,
  agent_account       text        NOT NULL,

  onchain_identity_id text,
  budget_position_id  text,

  per_call_cap        numeric(38,0),
  per_day_cap         numeric(38,0),

  -- sha256 of the bearer token the agent presents to the agent API.
  token_hash          text        NOT NULL UNIQUE,
  revoked_at          timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agents_owner_idx ON agents (owner_account);

CREATE TABLE calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          uuid        NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  agent_id            uuid        REFERENCES agents(id) ON DELETE SET NULL,

  payer_account       text,
  quoted_amount       numeric(38,0) NOT NULL,
  paid_amount         numeric(38,0),
  units               numeric(38,4),
  asset               text        NOT NULL DEFAULT '0.0.0',

  -- One settled payment may buy exactly one delivery. The unique index is the
  -- replay guard: a resubmitted X-PAYMENT cannot be served twice.
  payment_tx          text UNIQUE,

  request_hash        text,
  response_hash       text,

  status              text        NOT NULL DEFAULT 'quoted'
                        CHECK (status IN ('quoted','paid','delivered','failed','refunded')),
  http_status         int,
  latency_ms          int,
  error               text,

  hcs_receipt_id      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz
);

CREATE INDEX calls_service_idx ON calls (service_id, created_at DESC);
CREATE INDEX calls_agent_idx   ON calls (agent_id, created_at DESC);
CREATE INDEX calls_status_idx  ON calls (status);
CREATE INDEX calls_created_idx ON calls (created_at DESC);

CREATE TABLE claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id             uuid        NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  reason              text        NOT NULL
                        CHECK (reason IN ('no_response','malformed','wrong_data','timeout','other')),
  evidence            text        NOT NULL DEFAULT '',

  status              text        NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','upheld','rejected')),
  resolution          text,

  payout_amount       numeric(38,0),
  payout_tx           text,
  hcs_receipt_id      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE INDEX claims_status_idx ON claims (status, created_at DESC);

-- Revenue notes (Module: Asset Tokenization Studio). Defined up front so the
-- schema does not churn when the tokenisation module lands.
CREATE TABLE revenue_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid        NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  period_start        date        NOT NULL,
  period_end          date        NOT NULL,
  face_value          numeric(38,0) NOT NULL,
  discount_bps        int         NOT NULL,
  issue_price         numeric(38,0) NOT NULL,
  asset               text        NOT NULL DEFAULT '0.0.0',

  ats_token_id        text,
  ats_contract_id     text,
  issue_tx            text,

  status              text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','issued','trading','matured','redeemed','defaulted')),

  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX revenue_notes_seller_idx ON revenue_notes (seller_id);

CREATE TABLE coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id             uuid        NOT NULL REFERENCES revenue_notes(id) ON DELETE CASCADE,
  due_at              timestamptz NOT NULL,
  amount              numeric(38,0) NOT NULL,
  status              text        NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','paid','missed')),
  paid_tx             text,
  scheduled_tx_id     text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coupons_note_idx ON coupons (note_id, due_at);

-- ---------------------------------------------------------------------------
-- HCS receipt outbox.
--
-- Consensus submission takes seconds; a paid HTTP request must not wait for
-- it. The gateway enqueues here and returns, and a Vercel Cron drain writes
-- to the topic and back-fills hcs_receipt_id on the call/claim.
-- ---------------------------------------------------------------------------
CREATE TABLE receipt_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text        NOT NULL CHECK (kind IN ('call','refund')),
  ref_id              uuid        NOT NULL,
  payload             jsonb       NOT NULL,

  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','failed')),
  attempts            int         NOT NULL DEFAULT 0,
  last_error          text,

  topic_id            text,
  hcs_receipt_id      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

CREATE INDEX receipt_outbox_pending_idx ON receipt_outbox (status, created_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX receipt_outbox_ref_idx ON receipt_outbox (kind, ref_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sellers_touch  BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER services_touch BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
