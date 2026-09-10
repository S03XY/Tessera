-- Free-tool quota, keyed to a human.
--
-- The free/paid pivot opened a hole: a free tool takes no payment, needs no
-- agent account and no token, so nothing stops one script from draining a
-- seller's upstream API quota at the seller's expense, forever. Payment was
-- doing all the rate limiting, and free calls do not pay.
--
-- A World ID nullifier is the cheapest honest answer. It makes an allowance
-- *per human* rather than per token or per IP, both of which are free to mint
-- in bulk. Crucially the credential can be low-assurance: the cost of wrongly
-- granting a larger free allowance is some upstream API calls, not money, so
-- demanding an Orb to use a free tool would be friction far out of proportion
-- to the risk being managed.

-- Which human, if any, stands behind an agent.
--
-- Deliberately NOT unique, unlike sellers.world_nullifier. One person may run
-- many agents — that is normal and useful — but every one of those agents
-- draws from that person's single free allowance, so running fifty buys
-- nothing. The same credential, two different policies, because the two
-- contexts are managing different risks.
ALTER TABLE agents
  ADD COLUMN world_nullifier text,
  ADD COLUMN world_credential text,
  ADD COLUMN verified_at timestamptz;

CREATE INDEX agents_world_nullifier_idx ON agents (world_nullifier)
  WHERE world_nullifier IS NOT NULL;

-- One row per bucket per day.
--
-- `bucket_key` is a nullifier, an agent id, or a coarse client fingerprint
-- depending on `bucket_kind`. Counting is an atomic UPSERT guarded on the
-- limit, so two concurrent free calls cannot both read "one under the cap"
-- and both proceed.
CREATE TABLE free_call_quota (
  bucket_kind text        NOT NULL CHECK (bucket_kind IN ('human', 'agent', 'anonymous')),
  bucket_key  text        NOT NULL,
  day         date        NOT NULL,
  used        integer     NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (bucket_kind, bucket_key, day)
);

-- Yesterday's counters are dead weight; this keeps the sweep cheap.
CREATE INDEX free_call_quota_day_idx ON free_call_quota (day);
