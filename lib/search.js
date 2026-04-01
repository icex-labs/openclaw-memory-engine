/**
 * Hybrid search: keyword + embedding cosine similarity + recency + access decay.
 */

import { loadArchival, rewriteArchival } from "./archival.js";
import { loadEmbeddingCache, getEmbedding, cosineSimilarity } from "./embedding.js";

/**
 * Search archival records with hybrid scoring.
 * @param {string} ws - workspace path
 * @param {string} query - search query
 * @param {number} topK - max results
 * @returns {Promise<object[]>} matched records
 */
export async function hybridSearch(ws, query, topK) {
  const records = loadArchival(ws);
  if (records.length === 0) return [];

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  const queryEmb = await getEmbedding(query);
  const embCache = loadEmbeddingCache(ws);

  const scored = records
    .map((record) => {
      const text = [record.content || "", record.entity || "", ...(record.tags || [])]
        .join(" ")
        .toLowerCase();

      // Keyword score
      let kwScore = 0;
      for (const term of queryTerms) {
        if (text.includes(term)) kwScore += 1;
      }
      if (queryTerms.length > 1 && text.includes(queryLower)) kwScore += 3;

      // Semantic score
      let semScore = 0;
      if (queryEmb && record.id) {
        const recEmb = embCache[record.id] || null;
        if (recEmb) {
          semScore = Math.max(0, cosineSimilarity(queryEmb, recEmb));
        }
      }

      // Recency bonus (0–1, decays over 1 year)
      let recencyScore = 0;
      if (record.ts) {
        const ageDays = (Date.now() - new Date(record.ts).getTime()) / 86400000;
        recencyScore = Math.max(0, 1 - ageDays / 365);
      }

      // Access decay bonus (0–0.5)
      let accessScore = 0;
      if (record.last_accessed) {
        const accessAgeDays =
          (Date.now() - new Date(record.last_accessed).getTime()) / 86400000;
        accessScore = Math.max(0, 0.5 - accessAgeDays / 180);
      }

      const total = kwScore * 2 + semScore * 5 + recencyScore + accessScore;
      return total > 0 ? { record, score: total } : null;
    })
    .filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topK);

  // Update access tracking
  const now = new Date().toISOString();
  let dirty = false;
  for (const s of results) {
    s.record.last_accessed = now;
    s.record.access_count = (s.record.access_count || 0) + 1;
    dirty = true;
  }
  if (dirty) rewriteArchival(ws, records);

  return results.map((s) => s.record);
}
