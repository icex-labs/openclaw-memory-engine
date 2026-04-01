/**
 * Deduplication via embedding cosine similarity.
 */

import { loadArchival, rewriteArchival } from "./archival.js";
import {
  loadEmbeddingCache, saveEmbeddingCache, getEmbedding, cosineSimilarity,
} from "./embedding.js";
import { DEDUP_SIMILARITY_THRESHOLD } from "./paths.js";

/**
 * Find near-duplicate pairs in archival memory.
 * @returns {Array<{ keep: object, drop: object, similarity: number }>}
 */
export async function findDuplicates(ws) {
  const records = loadArchival(ws);
  const embCache = loadEmbeddingCache(ws);

  // Build missing embeddings
  for (const r of records) {
    if (!embCache[r.id]) {
      const emb = await getEmbedding(
        [r.content, r.entity, ...(r.tags || [])].filter(Boolean).join(" "),
      );
      if (emb) embCache[r.id] = emb;
    }
  }
  saveEmbeddingCache(ws);

  // O(n²) pairwise comparison
  const dupes = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const embA = embCache[records[i].id];
      const embB = embCache[records[j].id];
      if (!embA || !embB) continue;
      const sim = cosineSimilarity(embA, embB);
      if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
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
  }
  return dupes;
}

/**
 * Remove duplicate records from archival.
 * @returns {{ removed: number, remaining: number }}
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
