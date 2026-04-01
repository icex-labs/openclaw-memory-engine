/**
 * Auto-extract structured facts from text blocks.
 * Splits by sentence boundaries (Chinese + English), infers entity, deduplicates.
 */

import { loadArchival, appendRecord } from "./archival.js";
import { indexEmbedding } from "./embedding.js";

/** Entity inference patterns. */
const ENTITY_PATTERNS = [
  [/\b(George|虾米哥)\b/i, "George"],
  [/\b(Jane|甄玉)\b/i, "Jane"],
  [/\b(Lawrence|Xuanqi)\b/i, "Lawrence"],
  [/\b(Tracy)\b/i, "Tracy"],
  [/\b(IBKR|Interactive Brokers)\b/i, "IBKR"],
  [/\b(GX550|Escalade|ES350|Lexus|Cadillac)\b/i, "vehicles"],
  [/\b(immigration|PR|IRCC|CBSA)\b/i, "immigration"],
  [/\b(quant|trading|backtest)\b/i, "netralis-quant"],
  [/\b(OpenClaw|gateway|plugin)\b/i, "OpenClaw"],
];

function inferEntity(text, fallback) {
  for (const [pat, name] of ENTITY_PATTERNS) {
    if (pat.test(text)) return name;
  }
  return fallback;
}

/** Split text into sentence-level fact candidates. */
function extractCandidates(text) {
  const rawLines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];

  for (const line of rawLines) {
    // Split by Chinese/English sentence boundaries
    const sentences = line
      .split(/(?<=[。.！!？?；;])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    segments.push(...(sentences.length > 1 ? sentences : [line]));
  }

  return segments
    .filter((seg) => {
      if (seg.startsWith("#") || seg.length < 10) return false;
      if (/^(##|===|---|\*\*\*)/.test(seg)) return false;
      return true;
    })
    .map((seg) => seg.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter((s) => s.length >= 10);
}

/** Check if a fact is a near-duplicate of existing content (keyword overlap >70%). */
function isDuplicate(factLower, existingTexts) {
  const factWords = new Set(factLower.split(/\s+/).filter((w) => w.length > 2));
  if (factWords.size === 0) return false;

  for (const ex of existingTexts) {
    const exWords = new Set(ex.split(/\s+/).filter((w) => w.length > 2));
    let overlap = 0;
    for (const w of factWords) {
      if (exWords.has(w)) overlap++;
    }
    if (overlap / factWords.size > 0.7) return true;
  }
  return false;
}

/**
 * Extract facts from text, deduplicate, and insert into archival.
 * @returns {{ inserted: string[], skipped: string[], total: number }}
 */
export async function consolidateText(ws, text, defaultEntity = "", defaultTags = []) {
  const candidates = extractCandidates(text);
  if (candidates.length === 0) return { inserted: [], skipped: [], total: 0 };

  const existing = loadArchival(ws);
  const existingTexts = existing.map((r) => (r.content || "").toLowerCase());
  const inserted = [];
  const skipped = [];

  for (const fact of candidates) {
    const factLower = fact.toLowerCase();

    if (isDuplicate(factLower, existingTexts)) {
      skipped.push(fact.slice(0, 60));
      continue;
    }

    const entity = inferEntity(fact, defaultEntity);
    const record = appendRecord(ws, {
      content: fact,
      entity,
      tags: defaultTags,
      source: "consolidate",
    });
    indexEmbedding(ws, record).catch(() => {});
    inserted.push(record.id);
    existingTexts.push(factLower);
  }

  return { inserted, skipped, total: candidates.length };
}
