/**
 * @icex-labs/openclaw-memory-engine v2.0.0
 *
 * MemGPT-style hierarchical memory plugin for OpenClaw.
 *
 * Tools (17):
 *   Core:        core_memory_read, core_memory_replace, core_memory_append
 *   Archival:    archival_insert, archival_search, archival_update, archival_delete, archival_stats
 *   Graph:       graph_query, graph_add
 *   Episodes:    episode_save, episode_recall
 *   Reflection:  memory_reflect
 *   Maintenance: archival_deduplicate, memory_consolidate
 *   Backup:      memory_export, memory_import
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync } from "node:fs";

import { resolveWorkspace, getCoreSizeLimit, DEFAULT_TOP_K, MAX_TOP_K } from "./lib/paths.js";
import { readCore, writeCore, dotGet, dotSet, autoParse } from "./lib/core.js";
import { loadArchival, appendRecord, rewriteArchival, archivalPath } from "./lib/archival.js";
import { indexEmbedding, loadEmbeddingCache, saveEmbeddingCache } from "./lib/embedding.js";
import { hybridSearch } from "./lib/search.js";
import { consolidateText } from "./lib/consolidate.js";
import { findDuplicates, applyDedup } from "./lib/dedup.js";
import { exportMemory, importMemory } from "./lib/backup.js";
import { queryGraph, addTriple, extractTriples } from "./lib/graph.js";
import { saveEpisode, recallEpisodes, indexEpisodeEmbedding } from "./lib/episodes.js";
import { analyzePatterns, formatReflection } from "./lib/reflection.js";

import { readFileSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════════
// Helper: format search results
// ═══════════════════════════════════════════════════════════════════

function formatResults(results) {
  return results
    .map(
      (r, i) =>
        `[${i + 1}] (${r.ts?.slice(0, 10) || "?"}) ${r.entity ? `[${r.entity}] ` : ""}${r.content}${r.tags?.length ? ` #${r.tags.join(" #")}` : ""}`,
    )
    .join("\n");
}

function text(msg) {
  return { content: [{ type: "text", text: msg }] };
}

// ═══════════════════════════════════════════════════════════════════
// Plugin entry
// ═══════════════════════════════════════════════════════════════════

export default definePluginEntry({
  id: "memory-engine",
  name: "Memory Engine",
  description:
    "MemGPT-style hierarchical memory: core block, archival storage, hybrid search, dedup, consolidate, backup/restore",

  register(api) {
    // ─── core_memory_read ───
    api.registerTool({
      name: "core_memory_read",
      description:
        "Read the entire core memory block. Contains user identity, relationship, preferences, and current focus. Call at session start.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params, ctx) {
        return text(JSON.stringify(readCore(resolveWorkspace(ctx)), null, 2));
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
        const value = autoParse(params.value);
        const old = dotSet(core, params.key, value);
        const size = JSON.stringify(core, null, 2).length;
        if (size > limit) {
          dotSet(core, params.key, old);
          return text(`ERROR: Would exceed ${limit}B limit (${size}B). Use archival_insert for details.`);
        }
        writeCore(ws, core);
        return text(`OK: ['${params.key}'] updated. Old: ${JSON.stringify(old)} → New: ${JSON.stringify(value)}`);
      },
    });

    // ─── core_memory_append ───
    api.registerTool({
      name: "core_memory_append",
      description:
        "Append an item to an array field in core memory (e.g., current_focus). Creates the array if needed.",
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
          return text(`ERROR: Would exceed ${limit}B limit. Remove an item first or use archival_insert.`);
        }
        writeCore(ws, core);
        return text(`OK: Appended "${params.item}" to ${params.key} (now ${arr.length} items)`);
      },
    });

    // ─── archival_insert ───
    api.registerTool({
      name: "archival_insert",
      description:
        "Store a memory/fact in archival storage. Tags with entity and tags. Auto-extracts knowledge graph triples. Set importance (1-10, default 5) to influence search ranking and forgetting.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to store (1-3 sentences, specific)" },
          entity: { type: "string", description: "Primary entity (e.g., 'George', 'GX550')" },
          tags: { type: "array", items: { type: "string" }, description: "Category tags" },
          importance: { type: "number", description: "1-10, how important is this fact? (default: 5). High=permanent, Low=may be forgotten." },
        },
        required: ["content"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const imp = Math.min(10, Math.max(1, params.importance ?? 5));
        const record = appendRecord(ws, {
          content: params.content,
          entity: params.entity || "",
          tags: params.tags || [],
          importance: imp,
        });
        indexEmbedding(ws, record).catch(() => {});

        // Auto-extract knowledge graph triples
        const triples = extractTriples(params.content);
        const graphResults = [];
        for (const t of triples) {
          const added = addTriple(ws, t.s, t.r, t.o, record.id);
          if (added) graphResults.push(`(${t.s} --${t.r}--> ${t.o})`);
        }

        let msg = `OK: Archived ${record.id} (importance=${imp}). "${record.content.slice(0, 80)}..."`;
        if (graphResults.length > 0) {
          msg += `\nGraph: extracted ${graphResults.length} relation(s): ${graphResults.join(", ")}`;
        }
        return text(msg);
      },
    });

    // ─── archival_search ───
    api.registerTool({
      name: "archival_search",
      description:
        "Hybrid search over archival memory: keyword + semantic similarity + recency + access decay. Use before answering factual questions.",
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
        if (results.length === 0) return text(`No archival memories found for: "${params.query}"`);
        return text(`Found ${results.length} results:\n${formatResults(results)}`);
      },
    });

    // ─── archival_update ───
    api.registerTool({
      name: "archival_update",
      description:
        "Update an existing archival record by ID. Use to correct wrong facts.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Record ID" },
          content: { type: "string", description: "New content" },
          entity: { type: "string", description: "New entity (optional)" },
          tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
        },
        required: ["id", "content"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const records = loadArchival(ws);
        const idx = records.findIndex((r) => r.id === params.id);
        if (idx === -1) return text(`ERROR: Record ${params.id} not found.`);
        const old = records[idx].content;
        records[idx].content = params.content;
        records[idx].updated_at = new Date().toISOString();
        if (params.entity !== undefined) records[idx].entity = params.entity;
        if (params.tags !== undefined) records[idx].tags = params.tags;
        rewriteArchival(ws, records);
        const embCache = loadEmbeddingCache(ws);
        delete embCache[params.id];
        saveEmbeddingCache(ws);
        indexEmbedding(ws, records[idx]).catch(() => {});
        return text(`OK: Updated ${params.id}. Old: "${old.slice(0, 60)}..." → New: "${params.content.slice(0, 60)}..."`);
      },
    });

    // ─── archival_delete ───
    api.registerTool({
      name: "archival_delete",
      description: "Delete an archival record by ID.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Record ID to delete" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const records = loadArchival(ws);
        const idx = records.findIndex((r) => r.id === params.id);
        if (idx === -1) return text(`ERROR: Record ${params.id} not found.`);
        const removed = records.splice(idx, 1)[0];
        rewriteArchival(ws, records);
        const embCache = loadEmbeddingCache(ws);
        delete embCache[params.id];
        saveEmbeddingCache(ws);
        return text(`OK: Deleted ${params.id}. Was: "${removed.content.slice(0, 80)}..."`);
      },
    });

    // ─── archival_stats ───
    api.registerTool({
      name: "archival_stats",
      description: "Show archival memory statistics.",
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
          entityCounts[r.entity || "(none)"] = (entityCounts[r.entity || "(none)"] || 0) + 1;
          for (const t of r.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
          if (r.ts && new Date(r.ts).getTime() > oneWeekAgo) recentCount++;
        }
        const topE = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, c]) => `  ${e}: ${c}`).join("\n");
        const topT = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        const p = archivalPath(ws);
        const fileSize = existsSync(p) ? readFileSync(p).length : 0;
        return text([
          `Total records: ${records.length}`,
          `Embedded: ${Object.keys(embCache).length}/${records.length}`,
          `Recent (7d): ${recentCount}`,
          `File size: ${(fileSize / 1024).toFixed(1)}KB`,
          `\nTop entities:\n${topE || "  (none)"}`,
          `\nTop tags:\n${topT || "  (none)"}`,
        ].join("\n"));
      },
    });

    // ─── archival_deduplicate ───
    api.registerTool({
      name: "archival_deduplicate",
      description:
        "Scan for near-duplicate records using embedding similarity. Preview by default; pass apply=true to remove.",
      parameters: {
        type: "object",
        properties: {
          apply: { type: "boolean", description: "If true, delete duplicates. Default: preview only." },
        },
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const dupes = await findDuplicates(ws);
        if (dupes.length === 0) return text("No duplicates found. Archival memory is clean.");
        const preview = dupes
          .map((d, i) => `[${i + 1}] sim=${d.similarity}\n  KEEP: ${d.keep.content.slice(0, 80)}\n  DROP: ${d.drop.content.slice(0, 80)}`)
          .join("\n\n");
        if (params.apply) {
          const { removed, remaining } = applyDedup(ws, dupes);
          return text(`Removed ${removed} duplicates (${remaining} remaining):\n\n${preview}`);
        }
        return text(`Found ${dupes.length} potential duplicates (preview, call with apply=true to remove):\n\n${preview}`);
      },
    });

    // ─── memory_consolidate ───
    api.registerTool({
      name: "memory_consolidate",
      description:
        "Extract structured facts from text (conversation summary, daily log). Splits by sentence, infers entity, deduplicates against existing archival.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to extract facts from" },
          default_entity: { type: "string", description: "Default entity if not inferred" },
          default_tags: { type: "array", items: { type: "string" }, description: "Default tags" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const result = await consolidateText(
          ws, params.text, params.default_entity || "", params.default_tags || [],
        );
        if (result.total === 0) return text("No extractable facts found in the provided text.");
        const lines = [
          `Extracted ${result.total} candidates, inserted ${result.inserted.length}, skipped ${result.skipped.length} (duplicate).`,
        ];
        if (result.inserted.length > 0) lines.push(`Inserted IDs: ${result.inserted.join(", ")}`);
        if (result.skipped.length > 0) lines.push(`Skipped: ${result.skipped.map((s) => `"${s}..."`).join(", ")}`);
        return text(lines.join("\n"));
      },
    });

    // ─── graph_query ───
    api.registerTool({
      name: "graph_query",
      description:
        "Query the knowledge graph from a starting entity. Returns connected nodes via relations. Use to answer relational questions like 'who is George's doctor' or 'what treats his condition'.",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Starting entity to query from (e.g., 'George', '荨麻疹')" },
          relation: { type: "string", description: "Optional: filter by relation type (e.g., 'has_doctor', 'treated_by')" },
          depth: { type: "number", description: "Traversal depth (default: 2, max: 4)" },
        },
        required: ["entity"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const depth = Math.min(params.depth || 2, 4);
        const results = queryGraph(ws, params.entity, params.relation || null, depth);
        if (results.length === 0) {
          return text(`No graph connections found for entity: "${params.entity}"`);
        }
        const fmt = results.map((r, i) =>
          `[${i + 1}] ${r.path.join(" ")} → ${r.node} (${r.triple.r})`,
        ).join("\n");
        return text(`Found ${results.length} connections from "${params.entity}":\n${fmt}`);
      },
    });

    // ─── graph_add ───
    api.registerTool({
      name: "graph_add",
      description:
        "Manually add a relation to the knowledge graph. Use when auto-extraction missed a relation, or to add relations you inferred from conversation.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Subject entity (e.g., 'George')" },
          relation: { type: "string", description: "Relation type (e.g., 'has_doctor', 'owns', 'lives_in')" },
          object: { type: "string", description: "Object entity (e.g., 'Dr. Mohamed', 'Edmonton')" },
        },
        required: ["subject", "relation", "object"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const triple = addTriple(ws, params.subject, params.relation, params.object);
        if (!triple) {
          return text(`Relation already exists: (${params.subject} --${params.relation}--> ${params.object})`);
        }
        return text(`OK: Added ${triple.id}: (${params.subject} --${params.relation}--> ${params.object})`);
      },
    });

    // ─── episode_save ───
    api.registerTool({
      name: "episode_save",
      description:
        "Save a conversation episode (summary of what was discussed, decisions made, mood). Call at end of meaningful conversations. Enables 'what did we discuss last time about X?' queries.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "1-3 sentence summary of the conversation" },
          decisions: { type: "array", items: { type: "string" }, description: "Decisions or action items from the conversation" },
          mood: { type: "string", description: "Emotional tone (e.g., 'relaxed', 'stressed', 'excited', 'serious')" },
          topics: { type: "array", items: { type: "string" }, description: "Topic tags (e.g., ['vehicles', 'finance'])" },
          participants: { type: "array", items: { type: "string" }, description: "Who was in the conversation" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const ep = saveEpisode(ws, {
          summary: params.summary,
          decisions: params.decisions || [],
          mood: params.mood || "",
          topics: params.topics || [],
          participants: params.participants || [],
        });
        indexEpisodeEmbedding(ws, ep).catch(() => {});
        return text(`OK: Episode saved ${ep.id}. "${ep.summary.slice(0, 100)}..."\n  Decisions: ${ep.decisions.length}, Topics: ${ep.topics.join(", ") || "(none)"}, Mood: ${ep.mood || "(none)"}`);
      },
    });

    // ─── episode_recall ───
    api.registerTool({
      name: "episode_recall",
      description:
        "Search past conversation episodes by topic/keyword, or get the most recent N episodes. Use to recall 'what did we discuss about X last time'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (topic, keyword). Omit to get recent episodes." },
          last_n: { type: "number", description: "Number of episodes to return (default: 5)" },
        },
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const lastN = params.last_n || 5;
        const results = await recallEpisodes(ws, params.query || null, lastN);
        if (results.length === 0) {
          return text(params.query ? `No episodes found for: "${params.query}"` : "No episodes recorded yet.");
        }
        const fmt = results.map((ep, i) => {
          const decisions = ep.decisions?.length ? `\n     Decisions: ${ep.decisions.join("; ")}` : "";
          const mood = ep.mood ? ` [${ep.mood}]` : "";
          return `[${i + 1}] (${ep.ts?.slice(0, 10)}) ${ep.summary}${mood}${decisions}`;
        }).join("\n\n");
        return text(`${results.length} episode(s):\n\n${fmt}`);
      },
    });

    // ─── memory_reflect ───
    api.registerTool({
      name: "memory_reflect",
      description: [
        "Analyze recent memory for behavioral patterns, topic trends, mood shifts, and memory health.",
        "Returns structured report with: top topics, time-of-day distribution, mood trend,",
        "importance distribution, neglected entities, and forgetting candidates.",
        "Use during heartbeats or when you want to understand what's been happening lately.",
        "After reviewing the report, store meaningful observations via archival_insert with tags=['reflection'].",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          window_days: { type: "number", description: "Analysis window in days (default: 7, max: 30)" },
        },
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const window = Math.min(params.window_days || 7, 30);
        const analysis = analyzePatterns(ws, window);
        const report = formatReflection(analysis);
        return text(report);
      },
    });

    // ─── memory_export ───
    api.registerTool({
      name: "memory_export",
      description:
        "Export entire memory (core + archival + embeddings) to a JSON file for backup or migration.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Output file path (default: memory/export-YYYY-MM-DD.json)" },
        },
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const { path, stats } = exportMemory(ws, params.output_path);
        const sizeKB = (readFileSync(path).length / 1024).toFixed(1);
        return text(`OK: Exported to ${path} (${sizeKB}KB)\n  Core: ${stats.core_size}B\n  Archival: ${stats.archival_count} records\n  Embeddings: ${stats.embedding_count}`);
      },
    });

    // ─── memory_import ───
    api.registerTool({
      name: "memory_import",
      description:
        "Import a memory export file. Modes: 'replace' (overwrite all) or 'merge' (add missing). Default: merge.",
      parameters: {
        type: "object",
        properties: {
          input_path: { type: "string", description: "Path to export JSON file" },
          mode: { type: "string", description: "'replace' or 'merge' (default: merge)" },
        },
        required: ["input_path"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        try {
          const result = importMemory(ws, params.input_path, params.mode || "merge");
          return text(`OK: ${result}`);
        } catch (e) {
          return text(`ERROR: ${e.message}`);
        }
      },
    });
  },
});
