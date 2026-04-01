/**
 * Shared path resolution and config helpers.
 */

import { join } from "node:path";

export const DEFAULT_CORE_SIZE_LIMIT = 3072;
export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 20;
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 512;
export const DEDUP_SIMILARITY_THRESHOLD = 0.92;

import { readFileSync as _readFileSync, existsSync as _existsSync } from "node:fs";

/**
 * Agent→workspace mapping, loaded once from openclaw.json.
 * Since OpenClaw v2026.3.x doesn't pass agentId/workspaceDir to plugin tools,
 * we read the config and let agents pass their ID via tool params.
 */
let _agentMap = null;

function loadAgentMap() {
  if (_agentMap) return _agentMap;
  _agentMap = {};
  try {
    const configPath = join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
    if (_existsSync(configPath)) {
      const cfg = JSON.parse(_readFileSync(configPath, "utf-8"));
      const defaultWs = cfg?.agents?.defaults?.workspace || join(process.env.HOME || "/tmp", ".openclaw", "workspace");
      _agentMap._default = defaultWs;
      for (const agent of cfg?.agents?.list || []) {
        _agentMap[agent.id] = agent.workspace || defaultWs;
      }
    }
  } catch { /* ignore */ }
  return _agentMap;
}

/**
 * Resolve workspace.
 * @param {object} ctx - OpenClaw tool context
 * @param {string} [agentId] - optional agent ID from tool params (workaround for OpenClaw not passing ctx)
 */
export function resolveWorkspace(ctx, agentId = null) {
  // 1. ctx.workspaceDir (future OpenClaw versions)
  if (ctx?.workspaceDir) return ctx.workspaceDir;
  // 2. Explicit agentId → lookup from config
  const aid = agentId || ctx?.agentId;
  if (aid) {
    const map = loadAgentMap();
    if (map[aid]) return map[aid];
  }
  // 3. Plugin config workspace
  if (ctx?.config?.workspace) return ctx.config.workspace;
  // 4. Env
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  // 5. Default
  return join(process.env.HOME || "/tmp", ".openclaw", "workspace");
}

export function getCoreSizeLimit(ctx) {
  return ctx?.config?.coreSizeLimit || DEFAULT_CORE_SIZE_LIMIT;
}

export function corePath(ws) { return join(ws, "memory", "core.json"); }
export function archivalPath(ws) { return join(ws, "memory", "archival.jsonl"); }
export function embeddingCachePath(ws) { return join(ws, "memory", "archival.embeddings.json"); }
export function graphPath(ws) { return join(ws, "memory", "graph.jsonl"); }
export function episodesPath(ws) { return join(ws, "memory", "episodes.jsonl"); }

export const DEFAULT_IMPORTANCE = 5;
export const FORGETTING_DECAY_RATE = 0.01; // importance decays by this per day without access
export const FORGETTING_THRESHOLD = 1.0;   // below this = candidate for archiving

// Multi-agent sharing (default: on for single-user multi-agent setups)
// Set to false in config for privacy-sensitive scenarios (e.g., separate users per agent)
export function isSharingEnabled(ctx) {
  return ctx?.config?.sharing !== false; // default true, explicitly set false to disable
}
