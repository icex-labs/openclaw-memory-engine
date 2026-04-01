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

export function resolveWorkspace(ctx) {
  return (
    ctx?.config?.workspace ||
    process.env.OPENCLAW_WORKSPACE ||
    join(process.env.HOME || "/tmp", ".openclaw", "workspace")
  );
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
