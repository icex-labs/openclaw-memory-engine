/**
 * @openclaw/memory-engine — MemGPT-style hierarchical memory plugin
 *
 * Install: openclaw plugins install @openclaw/memory-engine
 * Or:      npm install -g @openclaw/memory-engine
 *
 * Provides 4 agent tools:
 *   1. core_memory_read    — Read the core memory block
 *   2. core_memory_replace — Atomically update a section of core memory
 *   3. archival_insert     — Store a fact/memory in archival storage
 *   4. archival_search     — Semantic search over archival storage
 *
 * Storage:
 *   - Core memory:    <workspace>/memory/core.json  (~500 tokens, always small)
 *   - Archival store: <workspace>/memory/archival.jsonl  (append-only, unlimited)
 *
 * Config (openclaw.json → plugins.entries.memory-engine.config):
 *   - workspace: path to workspace directory (default: auto-resolved)
 *   - coreSizeLimit: max bytes for core.json (default: 3072)
 *   - archivalSearchTopK: default top_k for search (default: 5)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// --- Constants ---

const DEFAULT_CORE_SIZE_LIMIT = 3072; // 3KB
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

const DEFAULT_CORE_TEMPLATE = {
  _meta: {
    version: 1,
    updated_at: new Date().toISOString(),
    description: "Core memory block — always in context. Keep under 500 tokens.",
  },
  user: {},
  relationship: {},
  preferences: {},
  current_focus: [],
};

// --- Helpers ---

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

function corePath(workspace) {
  return join(workspace, "memory", "core.json");
}

function archivalPath(workspace) {
  return join(workspace, "memory", "archival.jsonl");
}

function readCore(workspace) {
  const p = corePath(workspace);
  if (!existsSync(p)) {
    mkdirSync(join(workspace, "memory"), { recursive: true });
    writeFileSync(p, JSON.stringify(DEFAULT_CORE_TEMPLATE, null, 2), "utf-8");
    return { ...DEFAULT_CORE_TEMPLATE };
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeCore(workspace, data) {
  data._meta = data._meta || {};
  data._meta.updated_at = new Date().toISOString();
  writeFileSync(corePath(workspace), JSON.stringify(data, null, 2), "utf-8");
}

function appendArchival(workspace, entry) {
  const p = archivalPath(workspace);
  const record = {
    id: `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(p, JSON.stringify(record) + "\n", "utf-8");
  return record.id;
}

function searchArchival(workspace, query, topK) {
  const p = archivalPath(workspace);
  if (!existsSync(p)) return [];

  const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  const scored = lines
    .map((line) => {
      try {
        const record = JSON.parse(line);
        const text = [record.content || "", record.entity || "", ...(record.tags || [])]
          .join(" ")
          .toLowerCase();

        let score = 0;
        for (const term of queryTerms) {
          if (text.includes(term)) score += 1;
        }
        // Exact phrase bonus
        if (queryTerms.length > 1 && text.includes(queryLower)) score += 3;

        // Recency bonus (0-1 scale, decays over 1 year)
        if (record.ts) {
          const ageDays = (Date.now() - new Date(record.ts).getTime()) / 86400000;
          score += Math.max(0, 1 - ageDays / 365);
        }
        return score > 0 ? { record, score } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((s) => s.record);
}

// --- Plugin Entry ---

export default definePluginEntry({
  id: "memory-engine",
  name: "Memory Engine",
  description:
    "MemGPT-style hierarchical memory: core memory block (always loaded, ~500 tokens) + archival storage (unlimited, keyword search with recency boost)",

  register(api) {
    // ─── Tool 1: core_memory_read ───
    api.registerTool({
      name: "core_memory_read",
      description:
        "Read the entire core memory block. Core memory is your persistent identity — key facts about your user, relationship, preferences, and current focus areas. Always kept small (~500 tokens). Call at session start or when you need fundamental context.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_id, _params, ctx) {
        const ws = resolveWorkspace(ctx);
        const core = readCore(ws);
        return {
          content: [{ type: "text", text: JSON.stringify(core, null, 2) }],
        };
      },
    });

    // ─── Tool 2: core_memory_replace ───
    api.registerTool({
      name: "core_memory_replace",
      description:
        "Atomically update a field in core memory using dot-path notation (e.g., 'user.location', 'relationship.trust', 'current_focus'). Core memory must stay small — for detailed/historical info, use archival_insert instead.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Dot-path key to update (e.g., 'user.location', 'current_focus')",
          },
          value: {
            description: "New value — string, array, or object",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const sizeLimit = getCoreSizeLimit(ctx);
        const core = readCore(ws);

        const parts = params.key.split(".");
        let obj = core;
        for (let i = 0; i < parts.length - 1; i++) {
          if (obj[parts[i]] === undefined) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        const lastKey = parts[parts.length - 1];
        const oldValue = obj[lastKey];
        obj[lastKey] = params.value;

        const serialized = JSON.stringify(core, null, 2);
        if (serialized.length > sizeLimit) {
          obj[lastKey] = oldValue;
          return {
            content: [
              {
                type: "text",
                text: `ERROR: Update would make core memory ${serialized.length}B (limit ${sizeLimit}B). Move detailed info to archival_insert instead.`,
              },
            ],
          };
        }

        writeCore(ws, core);
        return {
          content: [
            {
              type: "text",
              text: `OK: core_memory['${params.key}'] updated. Old: ${JSON.stringify(oldValue)} → New: ${JSON.stringify(params.value)}`,
            },
          ],
        };
      },
    });

    // ─── Tool 3: archival_insert ───
    api.registerTool({
      name: "archival_insert",
      description:
        "Store a memory/fact in archival storage (unlimited, append-only). Use for conversation summaries, learned facts, decisions, events, technical details. Tag entries with entity and tags for better retrieval.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory/fact to store (1-3 sentences, be specific)",
          },
          entity: {
            type: "string",
            description: "Primary entity (e.g., 'George', 'GX550', 'IBKR', 'immigration')",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for retrieval (e.g., ['finance', 'decision'])",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const id = appendArchival(ws, {
          content: params.content,
          entity: params.entity || "",
          tags: params.tags || [],
        });
        return {
          content: [
            {
              type: "text",
              text: `OK: Archived as ${id}. Content: "${params.content.slice(0, 100)}${params.content.length > 100 ? "..." : ""}"`,
            },
          ],
        };
      },
    });

    // ─── Tool 4: archival_search ───
    api.registerTool({
      name: "archival_search",
      description:
        "Search archival memory for relevant facts/memories. Uses keyword matching with recency boost. Use when you need to recall specific details not in core memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — use specific keywords (e.g., 'GX550 winter tires')",
          },
          top_k: {
            type: "number",
            description: `Number of results (default: ${DEFAULT_TOP_K}, max: ${MAX_TOP_K})`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_id, params, ctx) {
        const ws = resolveWorkspace(ctx);
        const topK = Math.min(params.top_k || DEFAULT_TOP_K, MAX_TOP_K);
        const results = searchArchival(ws, params.query, topK);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No archival memories found for: "${params.query}"` }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (${r.ts?.slice(0, 10) || "?"}) ${r.entity ? `[${r.entity}] ` : ""}${r.content}${r.tags?.length ? ` #${r.tags.join(" #")}` : ""}`
          )
          .join("\n");

        return {
          content: [{ type: "text", text: `Found ${results.length} results:\n${formatted}` }],
        };
      },
    });
  },
});
