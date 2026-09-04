-- ===========================================================================
-- Tokenized seller deposits.
--
-- The deposit itself moves to an ERC-1400 security token issued through
-- Hedera's Asset Tokenization Studio (see ../tollgate-ats). The marketplace
-- stops custodying it and becomes the escrow on a hold instead: it can lock a
-- seller's units and pay them to a named beneficiary, but it can never move
-- them to itself.
--
-- This app does not issue tokens — the ATS SDK is a 1.4GB dependency that has
-- no business in a serverless build. It records what was issued and reads
-- balances back over the JSON-RPC relay, which needs no SDK at all.
-- ===========================================================================

ALTER TABLE sellers ADD COLUMN ats_token_id      text;
ALTER TABLE sellers ADD COLUMN ats_holder_address text;

-- Nullable throughout: a seller with an HBAR deposit and no token is the
-- normal case today, and must keep working exactly as before.
COMMENT ON COLUMN sellers.ats_token_id IS
  'Hedera contract id of the ERC-1400 deposit bond, e.g. 0.0.10367762';
COMMENT ON COLUMN sellers.ats_holder_address IS
  'EVM address holding this seller''s deposit units';

-- A dispute that was settled by executing an on-chain hold records which one,
-- so the refund can be checked against the ledger rather than taken on trust.
ALTER TABLE claims ADD COLUMN ats_hold_id  integer;
ALTER TABLE claims ADD COLUMN ats_hold_tx  text;

CREATE INDEX sellers_ats_token_idx ON sellers (ats_token_id)
  WHERE ats_token_id IS NOT NULL;
