/**
 * Export/import for backup and migration.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readCore, writeCore } from "./core.js";
import { loadArchival, appendRecord, rewriteArchival } from "./archival.js";
import { loadEmbeddingCache, saveEmbeddingCache } from "./embedding.js";

const FORMAT_TAG = "openclaw-memory-engine";
const FORMAT_VERSION = "1.2.0";

/**
 * Export core + archival + embeddings to a JSON file.
 * @returns {{ path: string, stats: object }}
 */
export function exportMemory(ws, outputPath) {
  const date = new Date().toISOString().slice(0, 10);
  const outPath = outputPath || join(ws, "memory", `export-${date}.json`);

  const core = readCore(ws);
  const records = loadArchival(ws);
  const embeddings = loadEmbeddingCache(ws);

  const data = {
    _meta: {
      format: FORMAT_TAG,
      version: FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      workspace: ws,
    },
    core,
    archival: records,
    embeddings,
    stats: {
      core_size: JSON.stringify(core).length,
      archival_count: records.length,
      embedding_count: Object.keys(embeddings).length,
    },
  };

  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  return { path: outPath, stats: data.stats };
}

/**
 * Import from an export file.
 * @param {string} mode - "replace" or "merge"
 * @returns {string} result description
 */
export function importMemory(ws, inputPath, mode = "merge") {
  if (!existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

  const raw = readFileSync(inputPath, "utf-8");
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }

  if (data._meta?.format !== FORMAT_TAG) {
    throw new Error("Not a memory-engine export file.");
  }

  if (mode === "replace") {
    if (data.core) writeCore(ws, data.core);
    if (data.archival) rewriteArchival(ws, data.archival);
    if (data.embeddings) {
      // Direct write to cache + disk
      const cache = loadEmbeddingCache(ws);
      Object.assign(cache, data.embeddings);
      saveEmbeddingCache(ws);
    }
    return `REPLACED: core + ${data.archival?.length || 0} archival + ${Object.keys(data.embeddings || {}).length} embeddings`;
  }

  // Merge mode
  const existing = loadArchival(ws);
  const existingContents = new Set(existing.map((r) => r.content));
  const importRecords = data.archival || [];

  let added = 0;
  for (const r of importRecords) {
    if (!existingContents.has(r.content)) {
      appendRecord(ws, { content: r.content, entity: r.entity, tags: r.tags, source: "import" });
      existingContents.add(r.content);
      added++;
    }
  }

  let embAdded = 0;
  if (data.embeddings) {
    const embCache = loadEmbeddingCache(ws);
    for (const [id, emb] of Object.entries(data.embeddings)) {
      if (!embCache[id]) { embCache[id] = emb; embAdded++; }
    }
    saveEmbeddingCache(ws);
  }

  return `MERGED: ${added} new records (${importRecords.length - added} skipped), ${embAdded} new embeddings`;
}
