/**
 * Auto-capture: hook into message events, passively store facts.
 * Uses embedding-based classification (v5.0) — no hardcoded keywords.
 */

import { loadArchival, appendRecord } from "./archival.js";
import { getEmbedding, indexEmbedding } from "./embedding.js";
import { extractTriples, addTriple } from "./graph.js";
import { classify } from "./classifier.js";

const MIN_LENGTH = 20;
const MAX_LENGTH = 500;

// Skip very short / obvious non-fact messages (language-agnostic via length)
const SKIP_EXACT = new Set(["heartbeat_ok", "ok", "yes", "no", "y", "n"]);

/** Recent capture cache to prevent duplicates. */
const recentCaptures = new Map();
const DEDUP_WINDOW_MS = 60_000;

function shouldCapture(content) {
  if (!content || content.length < MIN_LENGTH) return false;
  const lower = content.trim().toLowerCase();
  if (SKIP_EXACT.has(lower)) return false;
  if (lower.startsWith("/")) return false; // slash commands
  return true;
}

/**
 * Process a message and auto-store if valuable.
 * Classification is embedding-based — works with any language.
 */
export async function captureMessage(ws, content, source = "auto-capture") {
  if (!shouldCapture(content)) return null;

  // Dedup: skip if same content captured in last 60s
  const contentHash = content.slice(0, 100).toLowerCase().replace(/\s+/g, " ");
  const now = Date.now();
  if (recentCaptures.has(contentHash) && now - recentCaptures.get(contentHash) < DEDUP_WINDOW_MS) {
    return null;
  }
  recentCaptures.set(contentHash, now);

  // Clean old dedup entries
  if (recentCaptures.size > 200) {
    for (const [key, ts] of recentCaptures) {
      if (now - ts > DEDUP_WINDOW_MS) recentCaptures.delete(key);
    }
  }

  // Check against recent archival records (keyword overlap)
  const existing = loadArchival(ws);
  const contentLower = content.toLowerCase();
  const contentWords = new Set(contentLower.split(/\s+/).filter((w) => w.length > 2));
  if (contentWords.size > 0) {
    for (let i = existing.length - 1; i >= Math.max(0, existing.length - 50); i--) {
      const ex = (existing[i].content || "").toLowerCase();
      const exWords = new Set(ex.split(/\s+/).filter((w) => w.length > 2));
      let overlap = 0;
      for (const w of contentWords) { if (exWords.has(w)) overlap++; }
      if (overlap / contentWords.size > 0.7) return null;
    }
  }

  // Trim long messages
  const trimmed = content.length > MAX_LENGTH ? content.slice(0, MAX_LENGTH - 3) + "..." : content;

  // Classify using embeddings (language-agnostic)
  const { entity, importance, embedding } = await classify(trimmed, ws);

  const record = appendRecord(ws, {
    content: trimmed,
    entity,
    tags: [source],
    importance,
  });

  // Reuse embedding for search indexing (no duplicate API call)
  if (embedding) {
    const { loadEmbeddingCache, saveEmbeddingCache } = await import("./embedding.js");
    const cache = loadEmbeddingCache(ws);
    cache[record.id] = embedding;
    saveEmbeddingCache(ws);
  }

  // Extract graph triples
  const triples = extractTriples(trimmed);
  for (const t of triples) {
    addTriple(ws, t.s, t.r, t.o, record.id);
  }

  return record;
}
