/**
 * Deduplication via embedding cosine similarity.
 * v5.2: smarter dedup — ignores records with different numbers/dates/IDs.
 */

import { loadArchival, rewriteArchival } from "./archival.js";
import {
  loadEmbeddingCache, saveEmbeddingCache, getEmbedding, cosineSimilarity,
} from "./embedding.js";

// Raised from 0.92 to 0.96 — fewer false positives
const DEDUP_THRESHOLD = 0.96;

/**
 * Extract numbers, dates, and IDs from text for comparison.
 * Two records with different numbers are NOT duplicates even if semantically similar.
 */
function extractIdentifiers(text) {
  const numbers = (text.match(/\$?[\d,.]+%?/g) || []).map((n) => n.replace(/[,$]/g, ""));
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const ids = text.match(/#\d+|PR\s*#?\d+|U\d{5,}|IMM-\d+/gi) || [];
  return [...numbers, ...dates, ...ids].map((s) => s.toLowerCase());
}

function hasDifferentIdentifiers(a, b) {
  const idsA = extractIdentifiers(a);
  const idsB = extractIdentifiers(b);
  if (idsA.length === 0 || idsB.length === 0) return false;
  // If both have identifiers but they differ → not duplicates
  const setA = new Set(idsA);
  const setB = new Set(idsB);
  const overlap = [...setA].filter((x) => setB.has(x)).length;
  return overlap === 0 && idsA.length > 0 && idsB.length > 0;
}

/**
 * Find near-duplicate pairs in archival memory.
 */
export async function findDuplicates(ws) {
  const records = loadArchival(ws);
  const embCache = loadEmbeddingCache(ws);

  for (const r of records) {
    if (!embCache[r.id]) {
      const emb = await getEmbedding(
        [r.content, r.entity, ...(r.tags || [])].filter(Boolean).join(" "),
      );
      if (emb) embCache[r.id] = emb;
    }
  }
  saveEmbeddingCache(ws);

  const dupes = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const embA = embCache[records[i].id];
      const embB = embCache[records[j].id];
      if (!embA || !embB) continue;
      const sim = cosineSimilarity(embA, embB);
      if (sim < DEDUP_THRESHOLD) continue;

      // Smart check: if records contain different numbers/dates/IDs, skip
      if (hasDifferentIdentifiers(records[i].content, records[j].content)) continue;

      const keepIdx =
        (records[j].access_count || 0) >= (records[i].access_count || 0) ? j : i;
      const dropIdx = keepIdx === i ? j : i;
      dupes.push({
        keep: records[keepIdx],
        drop: records[dropIdx],
        similarity: Math.round(sim * 1000) / 1000,
      });
    }
  }
  return dupes;
}

/**
 * Remove duplicate records from archival.
 */
export function applyDedup(ws, dupes) {
  const records = loadArchival(ws);
  const dropIds = new Set(dupes.map((d) => d.drop.id));
  const cleaned = records.filter((r) => !dropIds.has(r.id));
  rewriteArchival(ws, cleaned);

  const embCache = loadEmbeddingCache(ws);
  for (const id of dropIds) delete embCache[id];
  saveEmbeddingCache(ws);

  return { removed: dupes.length, remaining: cleaned.length };
}
