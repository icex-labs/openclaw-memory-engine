/**
 * @icex-labs/openclaw-memory-engine v1.1.0
 *
 * MemGPT-style hierarchical memory plugin for OpenClaw.
 *
 * Tools:
 *   Core:     core_memory_read, core_memory_replace, core_memory_append
 *   Archival: archival_insert, archival_search, archival_update, archival_delete, archival_stats
 *   Maintenance: archival_deduplicate
 *
 * Features:
 *   - Hybrid search: keyword matching + OpenAI embedding cosine similarity
 *   - Auto-parse safety for core_memory_replace (fixes LLM serialization bugs)
 *   - Access tracking + recency decay for archival search
 *   - In-memory index for fast search over large stores
 *   - Deduplication tool for cleaning similar records
 *   - Size-guarded core memory (default 3KB)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CORE_SIZE_LIMIT = 3072;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const EMBEDDING_MODEL = "text-embedding-3-small"; // cheaper + faster than large
const EMBEDDING_DIM = 512; // request reduced dimensions for speed
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

// ═══════════════════════════════════════════════════════════════════
// Resolve paths & config
// ═══════════════════════════════════════════════════════════════════

function resolveWorkspace(ctx) {
  return (
    ctx?.config?.workspace ||
    process.env.OPENCLAW_WORKSPACE ||
    join(process.env.HOME || "/tmp", ".openclaw", "workspace")
  );
}
function getCoreSizeLimit(ctx) {
  return ctx?.config?.coreSizeLimit || DEFAULT_CORE_SIZE_LIMIT;
}
function corePath(ws) { return join(ws, "memory", "core.json"); }
function archivalPath(ws) { return join(ws, "memory", "archival.jsonl"); }
function embeddingCachePath(ws) { return join(ws, "memory", "archival.embeddings.json"); }

// ═══════════════════════════════════════════════════════════════════
// Core memory helpers
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CORE = {
  _meta: { version: 1, updated_at: "", description: "Core memory block." },
  user: {}, relationship: {}, preferences: {}, current_focus: [],
};

function readCore(ws) {
  const p = corePath(ws);
  if (!existsSync(p)) {
    mkdirSync(join(ws, "memory"), { recursive: true });
    const init = { ...DEFAULT_CORE, _meta: { ...DEFAULT_CORE._meta, updated_at: new Date().toISOString() } };
    writeFileSync(p, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeCore(ws, data) {
  data._meta = data._meta || {};
  data._meta.updated_at = new Date().toISOString();
  writeFileSync(corePath(ws), JSON.stringify(data, null, 2), "utf-8");
}

/** Navigate a dot-path, creating intermediate objects as needed. */
function dotGet(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function dotSet(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const old = cur[parts[parts.length - 1]];
  cur[parts[parts.length - 1]] = value;
  return old;
}

/**
 * P0 fix: auto-parse value if it's a JSON string that should be an object/array.
 * LLMs sometimes pass '["a","b"]' as a string instead of an actual array.
 */
function autoParse(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try { return JSON.parse(trimmed); } catch { /* keep as string */ }
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Archival storage helpers
// ═══════════════════════════════════════════════════════════════════

/** In-memory archival index (lazy loaded per workspace). */
const archivalCache = new Map(); // ws → { records: [], dirty: false, loaded: false }

function loadArchival(ws) {
  if (archivalCache.has(ws) && archivalCache.get(ws).loaded) return archivalCache.get(ws).records;
  const p = archivalPath(ws);
  let records = [];
  if (existsSync(p)) {
    records = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }
  archivalCache.set(ws, { records, dirty: false, loaded: true });
  return records;
}

function appendRecord(ws, entry) {
  const record = {
    id: `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    last_accessed: null,
    access_count: 0,
    ...entry,
  };
  const p = archivalPath(ws);
  mkdirSync(join(ws, "memory"), { recursive: true });
  appendFileSync(p, JSON.stringify(record) + "\n", "utf-8");
  // Update cache
  if (archivalCache.has(ws) && archivalCache.get(ws).loaded) {
    archivalCache.get(ws).records.push(record);
  }
  return record;
}

function rewriteArchival(ws, records) {
  const p = archivalPath(ws);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  archivalCache.set(ws, { records: [...records], dirty: false, loaded: true });
}

// ═══════════════════════════════════════════════════════════════════
// Embedding helpers (OpenAI API)
// ═══════════════════════════════════════════════════════════════════

let embeddingCache = new Map(); // ws → { id → float[] }

function loadEmbeddingCache(ws) {
  if (embeddingCache.has(ws)) return embeddingCache.get(ws);
  const p = embeddingCachePath(ws);
  let cache = {};
  if (existsSync(p)) {
    try { cache = JSON.parse(readFileSync(p, "utf-8")); } catch { /* ignore */ }
  }
  embeddingCache.set(ws, cache);
  return cache;
}

function saveEmbeddingCache(ws) {
  const cache = embeddingCache.get(ws);
  if (!cache) return;
  writeFileSync(embeddingCachePath(ws), JSON.stringify(cache), "utf-8");
}

function resolveApiKey() {
  return process.env.OPENAI_API_KEY || null;
}

async function getEmbedding(text) {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch { return null; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ═══════════════════════════════════════════════════════════════════
// Hybrid search
// ═══════════════════════════════════════════════════════════════════

async function hybridSearch(ws, query, topK) {
  const records = loadArchival(ws);
  if (records.length === 0) return [];

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  // Try to get query embedding (non-blocking, falls back to keyword-only)
  const queryEmb = await getEmbedding(query);
  const embCache = loadEmbeddingCache(ws);
  let embCacheDirty = false;

  const scored = records.map((record) => {
    const text = [record.content || "", record.entity || "", ...(record.tags || [])]
      .join(" ").toLowerCase();

    // --- Keyword score (0-N) ---
    let kwScore = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) kwScore += 1;
    }
    if (queryTerms.length > 1 && text.includes(queryLower)) kwScore += 3;

    // --- Semantic score (0-1) ---
    let semScore = 0;
    if (queryEmb && record.id) {
      const recEmb = embCache[record.id] || null;
      if (recEmb) {
        semScore = Math.max(0, cosineSimilarity(queryEmb, recEmb));
      }
    }

    // --- Recency bonus (0-1) ---
    let recencyScore = 0;
    if (record.ts) {
      const ageDays = (Date.now() - new Date(record.ts).getTime()) / 86400000;
      recencyScore = Math.max(0, 1 - ageDays / 365);
    }

    // --- Access decay bonus (0-0.5) ---
    let accessScore = 0;
    if (record.last_accessed) {
      const accessAgeDays = (Date.now() - new Date(record.last_accessed).getTime()) / 86400000;
      accessScore = Math.max(0, 0.5 - accessAgeDays / 180);
    }

    // --- Combined: keyword dominates, semantic boosts ---
    const total = kwScore * 2 + semScore * 5 + recencyScore + accessScore;
    return total > 0 ? { record, score: total } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topK);

  // Update access tracking on returned results
  const now = new Date().toISOString();
  let archivalDirty = false;
  for (const s of results) {
    s.record.last_accessed = now;
    s.record.access_count = (s.record.access_count || 0) + 1;
    archivalDirty = true;
  }
  if (archivalDirty) rewriteArchival(ws, records);

  if (embCacheDirty) saveEmbeddingCache(ws);

  return results.map((s) => s.record);
}

// ═══════════════════════════════════════════════════════════════════
// Background embedding indexer
// ═══════════════════════════════════════════════════════════════════

async function indexEmbedding(ws, record) {
  if (!resolveApiKey()) return;
  const emb = await getEmbedding(
    [record.content, record.entity, ...(record.tags || [])].filter(Boolean).join(" ")
  );
  if (emb) {
    const cache = loadEmbeddingCache(ws);
    cache[record.id] = emb;
    saveEmbeddingCache(ws);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Deduplication
// ═══════════════════════════════════════════════════════════════════

async function findDuplicates(ws) {
  const records = loadArchival(ws);
  const embCache = loadEmbeddingCache(ws);
  const dupes = [];

  // Build embeddings for records that don't have them
  for (const r of records) {
    if (!embCache[r.id]) {
      const emb = await getEmbedding(
        [r.content, r.entity, ...(r.tags || [])].filter(Boolean).join(" ")
      );
      if (emb) embCache[r.id] = emb;
    }
  }
  saveEmbeddingCache(ws);

  // Compare all pairs (O(n²) — fine for <10K records)
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const embA = embCache[records[i].id];
      const embB = embCache[records[j].id];
      if (!embA || !embB) continue;
      const sim = cosineSimilarity(embA, embB);
      if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
        // Keep the newer or more accessed one
        const keepIdx = (records[j].access_count || 0) >= (records[i].access_count || 0) ? j : i;
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

// ═══════════════════════════════════════════════════════════════════
// Plugin Entry — Register Tools
// ═══════════════════════════════════════════════════════════════════

export default definePluginEntry({
  id: "memory-engine",
  name: "Memory Engine",
  description: "MemGPT-style hierarchical memory with core block, archival storage, hybrid search, and deduplication",

  register(api) {

    // ─── core_memory_read ───
    api.registerTool({
      name: "core_memory_read",
      description:
        "Read the entire core memory block. Contains user identity, relationship, preferences, and current focus. Call at session start.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params, ctx) {
        const core = readCore(resolveWorkspace(ctx));
        return { content: [{ type: "text", text: JSON.stringify(core, null, 2) }] };
      },
    });

    // ─── core_memory_replace ───
    api.registerTool({
      name: "core_memory_replace",
      description:
        "Atomically update a field in core memory using dot-path notation (e.g., 'user.location', 'current_focus'). Value is auto-parsed if it looks like JSON. Core memory must stay small (<3KB).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Dot-path key (e.g., 'user.location', 'current_focus')" },
          value: { description: "New value — string, array, or object. Auto-parsed from JSON strings." },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const limit = getCoreSizeLimit(ctx);
        const core = readCore(ws);
        const value = autoParse(params.value); // P0 fix
        const old = dotSet(core, params.key, value);
        const size = JSON.stringify(core, null, 2).length;
        if (size > limit) {
          dotSet(core, params.key, old);
          return { content: [{ type: "text", text: `ERROR: Would exceed ${limit}B limit (${size}B). Use archival_insert for details.` }] };
        }
        writeCore(ws, core);
        return { content: [{ type: "text", text: `OK: ['${params.key}'] updated. Old: ${JSON.stringify(old)} → New: ${JSON.stringify(value)}` }] };
      },
    });

    // ─── core_memory_append ───
    api.registerTool({
      name: "core_memory_append",
      description:
        "Append an item to an array field in core memory (e.g., append to current_focus). Creates the array if the field doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Dot-path to array field (e.g., 'current_focus')" },
          item: { type: "string", description: "Item to append" },
        },
        required: ["key", "item"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const limit = getCoreSizeLimit(ctx);
        const core = readCore(ws);
        let arr = dotGet(core, params.key);
        if (!Array.isArray(arr)) {
          arr = arr != null ? [arr] : [];
          dotSet(core, params.key, arr);
        }
        arr.push(params.item);
        const size = JSON.stringify(core, null, 2).length;
        if (size > limit) {
          arr.pop();
          return { content: [{ type: "text", text: `ERROR: Would exceed ${limit}B limit. Remove an item first or use archival_insert.` }] };
        }
        writeCore(ws, core);
        return { content: [{ type: "text", text: `OK: Appended "${params.item}" to ${params.key} (now ${arr.length} items)` }] };
      },
    });

    // ─── archival_insert ───
    api.registerTool({
      name: "archival_insert",
      description:
        "Store a memory/fact in archival storage (unlimited, append-only). Tag with entity and tags for retrieval. Embedding is computed in background for semantic search.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to store (1-3 sentences, specific)" },
          entity: { type: "string", description: "Primary entity (e.g., 'George', 'GX550')" },
          tags: { type: "array", items: { type: "string" }, description: "Category tags" },
        },
        required: ["content"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const record = appendRecord(ws, {
          content: params.content,
          entity: params.entity || "",
          tags: params.tags || [],
        });
        // Index embedding in background (non-blocking)
        indexEmbedding(ws, record).catch(() => {});
        return {
          content: [{ type: "text", text: `OK: Archived ${record.id}. "${record.content.slice(0, 100)}${record.content.length > 100 ? "..." : ""}"` }],
        };
      },
    });

    // ─── archival_search ───
    api.registerTool({
      name: "archival_search",
      description:
        "Hybrid search over archival memory: keyword matching + semantic similarity (if embeddings available) + recency boost + access frequency. Use before answering factual questions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query with specific keywords" },
          top_k: { type: "number", description: `Results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K})` },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const topK = Math.min(params.top_k || DEFAULT_TOP_K, MAX_TOP_K);
        const results = await hybridSearch(ws, params.query, topK);
        if (results.length === 0) {
          return { content: [{ type: "text", text: `No archival memories found for: "${params.query}"` }] };
        }
        const fmt = results.map((r, i) =>
          `[${i + 1}] (${r.ts?.slice(0, 10) || "?"}) ${r.entity ? `[${r.entity}] ` : ""}${r.content}${r.tags?.length ? ` #${r.tags.join(" #")}` : ""}`
        ).join("\n");
        return { content: [{ type: "text", text: `Found ${results.length} results:\n${fmt}` }] };
      },
    });

    // ─── archival_update ───
    api.registerTool({
      name: "archival_update",
      description:
        "Update an existing archival record by ID. Use to correct wrong facts or add missing details.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Record ID (from archival_search results)" },
          content: { type: "string", description: "New content (replaces old)" },
          entity: { type: "string", description: "New entity (optional, keeps old if omitted)" },
          tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
        },
        required: ["id", "content"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const records = loadArchival(ws);
        const idx = records.findIndex((r) => r.id === params.id);
        if (idx === -1) {
          return { content: [{ type: "text", text: `ERROR: Record ${params.id} not found.` }] };
        }
        const old = records[idx].content;
        records[idx].content = params.content;
        records[idx].updated_at = new Date().toISOString();
        if (params.entity !== undefined) records[idx].entity = params.entity;
        if (params.tags !== undefined) records[idx].tags = params.tags;
        rewriteArchival(ws, records);
        // Re-index embedding
        indexEmbedding(ws, records[idx]).catch(() => {});
        // Invalidate old embedding
        const embCache = loadEmbeddingCache(ws);
        delete embCache[params.id];
        saveEmbeddingCache(ws);
        return { content: [{ type: "text", text: `OK: Updated ${params.id}. Old: "${old.slice(0, 60)}..." → New: "${params.content.slice(0, 60)}..."` }] };
      },
    });

    // ─── archival_delete ───
    api.registerTool({
      name: "archival_delete",
      description:
        "Delete an archival record by ID. Use for outdated or incorrect facts.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Record ID to delete" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const records = loadArchival(ws);
        const idx = records.findIndex((r) => r.id === params.id);
        if (idx === -1) {
          return { content: [{ type: "text", text: `ERROR: Record ${params.id} not found.` }] };
        }
        const removed = records.splice(idx, 1)[0];
        rewriteArchival(ws, records);
        // Remove embedding
        const embCache = loadEmbeddingCache(ws);
        delete embCache[params.id];
        saveEmbeddingCache(ws);
        return { content: [{ type: "text", text: `OK: Deleted ${params.id}. Was: "${removed.content.slice(0, 80)}..."` }] };
      },
    });

    // ─── archival_stats ───
    api.registerTool({
      name: "archival_stats",
      description:
        "Show archival memory statistics: total records, entity distribution, recently active, storage size.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params, ctx) {
        const ws = resolveWorkspace(ctx);
        const records = loadArchival(ws);
        const embCache = loadEmbeddingCache(ws);

        const entityCounts = {};
        const tagCounts = {};
        let recentCount = 0;
        const oneWeekAgo = Date.now() - 7 * 86400000;

        for (const r of records) {
          const e = r.entity || "(none)";
          entityCounts[e] = (entityCounts[e] || 0) + 1;
          for (const t of r.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
          if (r.ts && new Date(r.ts).getTime() > oneWeekAgo) recentCount++;
        }

        const topEntities = Object.entries(entityCounts)
          .sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([e, c]) => `  ${e}: ${c}`).join("\n");
        const topTags = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([t, c]) => `  ${t}: ${c}`).join("\n");

        const embCount = Object.keys(embCache).length;
        const p = archivalPath(ws);
        const fileSize = existsSync(p) ? readFileSync(p).length : 0;

        const text = [
          `Total records: ${records.length}`,
          `Embedded: ${embCount}/${records.length}`,
          `Recent (7d): ${recentCount}`,
          `File size: ${(fileSize / 1024).toFixed(1)}KB`,
          ``,
          `Top entities:\n${topEntities || "  (none)"}`,
          ``,
          `Top tags:\n${topTags || "  (none)"}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },
    });

    // ─── archival_deduplicate ───
    api.registerTool({
      name: "archival_deduplicate",
      description:
        "Scan archival memory for duplicate/near-duplicate facts using embedding similarity. Shows duplicates found and optionally removes them. Run periodically to keep archival clean.",
      parameters: {
        type: "object",
        properties: {
          apply: {
            type: "boolean",
            description: "If true, actually delete duplicates. If false (default), just preview.",
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const dupes = await findDuplicates(ws);

        if (dupes.length === 0) {
          return { content: [{ type: "text", text: "No duplicates found. Archival memory is clean." }] };
        }

        const preview = dupes.map((d, i) =>
          `[${i + 1}] sim=${d.similarity}\n  KEEP: ${d.keep.content.slice(0, 80)}\n  DROP: ${d.drop.content.slice(0, 80)}`
        ).join("\n\n");

        if (params.apply) {
          const records = loadArchival(ws);
          const dropIds = new Set(dupes.map((d) => d.drop.id));
          const cleaned = records.filter((r) => !dropIds.has(r.id));
          rewriteArchival(ws, cleaned);
          // Clean embeddings
          const embCache = loadEmbeddingCache(ws);
          for (const id of dropIds) delete embCache[id];
          saveEmbeddingCache(ws);
          return {
            content: [{ type: "text", text: `Removed ${dupes.length} duplicates (${cleaned.length} records remaining):\n\n${preview}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Found ${dupes.length} potential duplicates (preview only, call with apply=true to remove):\n\n${preview}` }],
        };
      },
    });
  },
});
