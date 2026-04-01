/**
 * OpenAI embedding API + local file cache.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { embeddingCachePath, EMBEDDING_MODEL, EMBEDDING_DIM } from "./paths.js";

/** In-memory embedding cache keyed by workspace path. */
const cacheMap = new Map();

export function loadEmbeddingCache(ws) {
  if (cacheMap.has(ws)) return cacheMap.get(ws);
  const p = embeddingCachePath(ws);
  let data = {};
  if (existsSync(p)) {
    try { data = JSON.parse(readFileSync(p, "utf-8")); } catch { /* ignore */ }
  }
  cacheMap.set(ws, data);
  return data;
}

export function saveEmbeddingCache(ws) {
  const data = cacheMap.get(ws);
  if (!data) return;
  writeFileSync(embeddingCachePath(ws), JSON.stringify(data), "utf-8");
}

export function resolveApiKey() {
  return process.env.OPENAI_API_KEY || null;
}

/** Fetch embedding vector from OpenAI. Returns float[] or null. */
export async function getEmbedding(text) {
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

export function cosineSimilarity(a, b) {
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

/** Compute and cache embedding for a record (non-blocking). */
export async function indexEmbedding(ws, record) {
  if (!resolveApiKey()) return;
  const text = [record.content, record.entity, ...(record.tags || [])].filter(Boolean).join(" ");
  const emb = await getEmbedding(text);
  if (emb) {
    const cache = loadEmbeddingCache(ws);
    cache[record.id] = emb;
    saveEmbeddingCache(ws);
  }
}
