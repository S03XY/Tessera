/**
 * Appraisal — deciding whether a listing can answer the question *before*
 * paying for it.
 *
 * A marketplace where the buyer only finds out after settlement is not a
 * marketplace, it is a tip jar. The agent already checks price and spending
 * cap; this checks the one thing that actually matters, which is whether the
 * data on the other side has the shape of an answer.
 *
 * For a Graph-backed listing that question is answerable exactly, because a
 * subgraph publishes its schema. The agent reads the entities and fields the
 * subgraph really has and matches them against what the question is asking
 * for. When nothing matches it refuses to pay and says which concepts it could
 * not find — which is the interesting half of the behaviour, and the half
 * nobody demonstrates.
 *
 * The scoring is deterministic on purpose. An LLM would appraise more subtly,
 * but this runs on the paid path, has to be reproducible in a demo, and has to
 * be testable. `describeAppraisal` produces the sentence a model would have
 * written, from evidence that can be checked.
 */

import {
  getSubgraphSchema,
  GRAPH_API_KEY,
  type SubgraphSchema,
} from "@/lib/graph";

/* ------------------------------------------------------------- vocabulary */

/**
 * Words that carry no information about *what data* is wanted. Kept
 * deliberately small: over-filtering silently deletes the concept the buyer
 * actually asked about.
 */
const STOPWORDS = new Set([
  "a", "all", "an", "and", "any", "are", "as", "at", "be", "by", "can", "current",
  "currently", "data", "do", "does", "each", "every", "find", "for", "from", "get",
  "give", "has", "have", "how", "i", "in", "is", "it", "its", "latest", "list",
  "many", "me", "much", "my", "of", "on", "or", "please", "show", "some", "than",
  "that", "the", "their", "them", "there", "these", "they", "this", "to", "top",
  "total", "value", "want", "was", "were", "what", "when", "where", "which", "who",
  "will", "with", "would", "you", "your",
]);

/**
 * Splits identifiers and prose into comparable tokens: camelCase and
 * snake_case both come apart, so `totalValueLockedUSD` meets "locked".
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/**
 * Crude singularisation. "markets" and "market" must be the same concept, and
 * a real stemmer is a dependency this does not need.
 *
 * The guard matters more than the rule: an English plural essentially never
 * ends -ss, -us or -is, so "address", "status" and "basis" are words in their
 * own right. Stripping the s off those quietly corrupts the vocabulary a
 * refusal is later justified with.
 */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** The concepts a question is actually asking about. */
export function conceptsOf(question: string): string[] {
  const seen = new Set<string>();
  const concepts: string[] = [];

  for (const token of tokenize(question)) {
    if (STOPWORDS.has(token)) continue;
    if (token.length < 2) continue;
    // Bare numbers are parameters, not concepts.
    if (/^\d+$/.test(token)) continue;

    const root = singularize(token);
    if (seen.has(root)) continue;
    seen.add(root);
    concepts.push(root);
  }

  return concepts;
}

/** Every word a schema exposes, as singular roots. */
export function schemaVocabulary(schema: SubgraphSchema): Set<string> {
  const vocabulary = new Set<string>();

  const add = (text: string) => {
    for (const token of tokenize(text)) {
      if (token.length < 2) continue;
      vocabulary.add(singularize(token));
    }
  };

  for (const entity of schema.entities) {
    add(entity);
    for (const field of schema.fields[entity] ?? []) add(field);
  }

  return vocabulary;
}

/* -------------------------------------------------------------- appraisal */

export interface Appraisal {
  slug: string;
  name: string;
  subgraphId: string | null;
  /** False means: do not pay this seller for this question. */
  canAnswer: boolean;
  /** Share of the question's concepts the schema can express, 0..1. */
  confidence: number;
  matched: string[];
  missing: string[];
  /** True when the listing publishes no schema and had to be taken on trust. */
  unverified: boolean;
  reason: string;
}

/**
 * A question is considered answerable when the schema covers at least this
 * share of its concepts.
 *
 * Set from the failure that matters: paying for data that cannot answer is
 * worse than declining a listing that could have. Half is strict enough to
 * reject an unrelated subgraph and loose enough to tolerate the one word a
 * buyer phrased differently.
 */
export const ANSWER_THRESHOLD = 0.5;

export function appraiseAgainstSchema(
  question: string,
  schema: SubgraphSchema,
  listing: { slug: string; name: string; subgraphId: string },
): Appraisal {
  const concepts = conceptsOf(question);
  const vocabulary = schemaVocabulary(schema);

  const matched: string[] = [];
  const missing: string[] = [];

  for (const concept of concepts) {
    // Exact root match, or the schema word contains the concept as a stem
    // ("borrow" meeting "totalBorrowBalanceUSD").
    const hit =
      vocabulary.has(concept) ||
      [...vocabulary].some(
        (word) => word.length > 3 && (word.includes(concept) || concept.includes(word)),
      );
    (hit ? matched : missing).push(concept);
  }

  // A question with no concepts left after filtering tells us nothing, so it
  // cannot be used to justify a payment.
  const confidence = concepts.length === 0 ? 0 : matched.length / concepts.length;
  const canAnswer = concepts.length > 0 && confidence >= ANSWER_THRESHOLD;

  return {
    slug: listing.slug,
    name: listing.name,
    subgraphId: listing.subgraphId,
    canAnswer,
    confidence,
    matched,
    missing,
    unverified: false,
    reason: describeAppraisal({ canAnswer, confidence, matched, missing, concepts }),
  };
}

/** The sentence the agent puts in its trace. Evidence, not vibes. */
export function describeAppraisal(input: {
  canAnswer: boolean;
  confidence: number;
  matched: string[];
  missing: string[];
  concepts: string[];
}): string {
  const percent = Math.round(input.confidence * 100);

  if (input.concepts.length === 0) {
    return "The question carries no searchable concepts, so no schema can be shown to answer it.";
  }

  if (input.canAnswer) {
    const base = `Schema covers ${percent}% of the question — found ${input.matched
      .slice(0, 4)
      .join(", ")}.`;
    return input.missing.length
      ? `${base} No field for ${input.missing.slice(0, 3).join(", ")}, but enough to answer.`
      : base;
  }

  return (
    `Schema covers only ${percent}% of the question. ` +
    `Nothing in it expresses ${input.missing.slice(0, 4).join(", ")}. Not paying for this.`
  );
}

/**
 * A listing whose upstream is a plain HTTP endpoint publishes no schema, so
 * there is nothing to read and nothing to verify. That is stated rather than
 * scored, because pretending to have appraised it would be the dishonest move.
 */
export function unverifiableAppraisal(listing: {
  slug: string;
  name: string;
}): Appraisal {
  return {
    slug: listing.slug,
    name: listing.name,
    subgraphId: null,
    canAnswer: true,
    confidence: 0,
    matched: [],
    missing: [],
    unverified: true,
    reason:
      "Plain HTTP endpoint — it publishes no schema, so its fitness cannot be checked before paying.",
  };
}

/* ----------------------------------------------------------- the verdict */

export interface AppraisalInput {
  slug: string;
  name: string;
  upstreamKind: string;
  upstreamRef: string | null;
}

export interface AppraisalVerdict {
  appraisals: Appraisal[];
  /** The listing to buy from, or null when the agent is refusing. */
  chosen: Appraisal | null;
  refused: boolean;
  refusalReason: string | null;
}

/**
 * Appraises candidates in the order discovery ranked them (cheapest first) and
 * returns the first that can answer.
 *
 * Every candidate is appraised, not just the winner, so the trace can show
 * what was rejected and why — an agent that says "I looked at three and none
 * of them had a borrow field" is making a claim a judge can check.
 */
export async function appraiseCandidates(
  question: string,
  candidates: AppraisalInput[],
  apiKey: string = GRAPH_API_KEY,
): Promise<AppraisalVerdict> {
  const appraisals: Appraisal[] = [];

  for (const candidate of candidates) {
    if (candidate.upstreamKind !== "graph_subgraph" || !candidate.upstreamRef) {
      appraisals.push(unverifiableAppraisal(candidate));
      continue;
    }

    try {
      const schema = await getSubgraphSchema(candidate.upstreamRef, apiKey);
      appraisals.push(
        appraiseAgainstSchema(question, schema, {
          slug: candidate.slug,
          name: candidate.name,
          subgraphId: candidate.upstreamRef,
        }),
      );
    } catch (err) {
      // A schema that cannot be read is not a schema that failed to match.
      // Say so, and do not spend money on a guess.
      const reason = err instanceof Error ? err.message : String(err);
      appraisals.push({
        slug: candidate.slug,
        name: candidate.name,
        subgraphId: candidate.upstreamRef,
        canAnswer: false,
        confidence: 0,
        matched: [],
        missing: [],
        unverified: true,
        reason: `Could not read the schema (${reason}), so its fitness is unknown. Not paying blind.`,
      });
    }
  }

  const chosen = appraisals.find((entry) => entry.canAnswer) ?? null;

  return {
    appraisals,
    chosen,
    refused: chosen === null,
    refusalReason:
      chosen === null
        ? appraisals.length === 0
          ? "No candidate listings to appraise."
          : `Appraised ${appraisals.length} listing${
              appraisals.length === 1 ? "" : "s"
            }; none can answer this question. Refusing to pay.`
        : null,
  };
}
