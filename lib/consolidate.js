/**
 * Auto-extract structured facts from text blocks.
 * Splits by sentence boundaries (Chinese + English), infers entity, deduplicates.
 */

import { loadArchival, appendRecord } from "./archival.js";
import { indexEmbedding } from "./embedding.js";

/** Generic entity inference patterns (no personal data). */
const ENTITY_PATTERNS = [
  [/\b(IBKR|Interactive Brokers)\b/i, "IBKR"],
  [/\b(immigration|PR|IRCC|CBSA|visa)\b/i, "immigration"],
  [/\b(quant|trading|backtest|portfolio)\b/i, "trading"],
  [/\b(doctor|医生|hospital|医院|clinic)\b/i, "health"],
  [/\b(car|vehicle|SUV|sedan|truck|Tesla|Toyota|Lexus|BMW)\b/i, "vehicles"],
  [/\b(house|home|mortgage|rent|property)\b/i, "property"],
  [/\b(school|university|college|学校)\b/i, "education"],
  [/\b(insurance|保险)\b/i, "insurance"],
  [/\b(lawyer|律师|attorney|legal)\b/i, "legal"],
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
