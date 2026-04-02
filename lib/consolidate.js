/**
 * Extract structured facts from text blocks.
 * v5.0: embedding-based classification — no hardcoded keywords.
 */

import { loadArchival, appendRecord } from "./archival.js";
import { loadEmbeddingCache, saveEmbeddingCache } from "./embedding.js";
import { classify } from "./classifier.js";

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
      if (/^(##|===|---|\*\*\*|```|>|\|)/.test(seg)) return false;
      return true;
    })
    .map((seg) => seg.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter((s) => s.length >= 10);
}

function isDuplicate(factLower, existingTexts) {
  const factWords = new Set(factLower.split(/\s+/).filter((w) => w.length > 2));
  if (factWords.size === 0) return false;
  for (const ex of existingTexts) {
    const exWords = new Set(ex.split(/\s+/).filter((w) => w.length > 2));
    let overlap = 0;
    for (const w of factWords) { if (exWords.has(w)) overlap++; }
    if (overlap / factWords.size > 0.7) return true;
  }
  return false;
}

/**
 * Extract facts from text, classify via embeddings, deduplicate, and insert.
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

    const { entity, importance, embedding } = await classify(fact, ws);
    const finalEntity = (entity !== "general") ? entity : defaultEntity || "general";

    const record = appendRecord(ws, {
      content: fact,
      entity: finalEntity,
      tags: defaultTags,
      importance,
      source: "consolidate",
    });

    if (embedding) {
      const cache = loadEmbeddingCache(ws);
      cache[record.id] = embedding;
      saveEmbeddingCache(ws);
    }

    inserted.push(record.id);
    existingTexts.push(factLower);
  }

  return { inserted, skipped, total: candidates.length };
}
