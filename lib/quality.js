/**
 * Data quality engine v5.0: embedding-based classification.
 * Replaces hardcoded regex patterns with semantic similarity.
 * Language-agnostic — works with any language.
 */

import { loadArchival, rewriteArchival } from "./archival.js";
import { addTriple, extractTriples, loadGraph } from "./graph.js";
import { saveEpisode, loadEpisodes } from "./episodes.js";
import { loadEmbeddingCache } from "./embedding.js";
import { batchReclassify } from "./classifier.js";

/**
 * Run a full quality pass over archival records.
 * Uses embedding-based classification (no regex).
 * @returns {{ reclassified, rerated, triplesAdded, episodesGenerated }}
 */
export async function runQualityPass(ws, options = {}) {
  const records = loadArchival(ws);
  const embCache = loadEmbeddingCache(ws);

  // 1. Embedding-based re-classification (entity + importance)
  let reclassified = 0;
  let rerated = 0;

  const embeddedRecords = records.filter((r) => embCache[r.id]);
  if (embeddedRecords.length > 0) {
    const result = await batchReclassify(ws, embeddedRecords, embCache);
    reclassified = result.reclassified;
    rerated = result.rerated;
  }

  // 2. Extract graph triples
  let triplesAdded = 0;
  if (!options.skipGraph) {
    const existingGraph = loadGraph(ws);
    const existingTripleSet = new Set(
      existingGraph.map((t) => `${t.s}|${t.r}|${t.o}`.toLowerCase()),
    );
    for (const record of records) {
      const triples = extractTriples(record.content);
      for (const t of triples) {
        const key = `${t.s}|${t.r}|${t.o}`.toLowerCase();
        if (!existingTripleSet.has(key)) {
          const added = addTriple(ws, t.s, t.r, t.o, record.id);
          if (added) {
            existingTripleSet.add(key);
            triplesAdded++;
          }
        }
      }
    }
  }

  // 3. Save updated records
  if (reclassified > 0 || rerated > 0) {
    rewriteArchival(ws, records);
  }

  // 4. Generate episodes from daily record clusters
  let episodesGenerated = 0;
  if (!options.skipEpisodes) {
    episodesGenerated = generateEpisodesFromRecords(ws, records);
  }

  return { reclassified, rerated, triplesAdded, episodesGenerated, total: records.length };
}

/**
 * Generate episode summaries from clusters of records on the same day.
 */
function generateEpisodesFromRecords(ws, records) {
  const episodes = loadEpisodes(ws);
  const existingDates = new Set(episodes.map((e) => e.ts?.slice(0, 10)));

  const byDate = {};
  for (const r of records) {
    if (!r.ts) continue;
    const date = r.ts.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  let generated = 0;
  for (const [date, dayRecords] of Object.entries(byDate)) {
    if (existingDates.has(date) || dayRecords.length < 3) continue;

    const topics = [...new Set(dayRecords.map((r) => r.entity).filter((e) => e && e !== "general"))];
    const topContent = dayRecords
      .sort((a, b) => (b.importance || 5) - (a.importance || 5))
      .slice(0, 5)
      .map((r) => r.content.slice(0, 80))
      .join("; ");

    saveEpisode(ws, {
      summary: `${date}: ${topContent}`,
      decisions: [],
      mood: "",
      topics: topics.slice(0, 5),
      participants: [],
      source: "quality-pass",
    });
    generated++;
  }

  return generated;
}

/**
 * Format quality pass results into a report.
 */
export function formatQualityReport(result) {
  const lines = [
    `📊 Memory Quality Pass Complete (embedding-based v5.0)`,
    ``,
    `  Records scanned: ${result.total}`,
    `  Entities re-classified: ${result.reclassified} (via semantic similarity)`,
    `  Importance re-rated: ${result.rerated} (via semantic similarity)`,
    `  Graph triples extracted: ${result.triplesAdded}`,
    `  Episodes generated: ${result.episodesGenerated}`,
  ];

  if (result.reclassified === 0 && result.rerated === 0 && result.triplesAdded === 0 && result.episodesGenerated === 0) {
    lines.push(``, `  All data is already high quality. Nothing to fix.`);
  }

  return lines.join("\n");
}
