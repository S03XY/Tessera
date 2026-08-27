-- ===========================================================================
-- Agent-facing discovery keywords.
--
-- An agent asks for a capability in its own words ("bitcoin price"), not in
-- the seller's marketing words ("Coinbase spot price for BTC"). Keywords give
-- the seller somewhere to declare the synonyms so discovery actually hits.
--
-- The search text is assembled by an IMMUTABLE function because array_to_string
-- is only STABLE, and Postgres refuses to build an index expression on that.
-- ===========================================================================

ALTER TABLE services ADD COLUMN keywords text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION service_search_text(
  p_name        text,
  p_description text,
  p_category    text,
  p_keywords    text[]
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  joined text := '';
  word   text;
BEGIN
  IF p_keywords IS NOT NULL THEN
    FOREACH word IN ARRAY p_keywords LOOP
      joined := joined || ' ' || word;
    END LOOP;
  END IF;

  RETURN coalesce(p_name, '') || ' ' ||
         coalesce(p_description, '') || ' ' ||
         coalesce(p_category, '') || joined;
END;
$$;

DROP INDEX IF EXISTS services_search_idx;

CREATE INDEX services_search_idx ON services
  USING gin (
    to_tsvector(
      'english',
      service_search_text(name, description, category, keywords)
    )
  );
