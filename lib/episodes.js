/**
 * Episodic memory: conversation-level summaries with decisions, mood, and topics.
 * Enables "what did we discuss last time about X?" queries.
 *
 * Storage: memory/episodes.jsonl — one episode per line.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { episodesPath } from "./paths.js";
import { getEmbedding, cosineSimilarity, loadEmbeddingCache, saveEmbeddingCache } from "./embedding.js";

// ─── In-memory cache ───

const cache = new Map();

export function loadEpisodes(ws) {
  if (cache.has(ws) && cache.get(ws).loaded) return cache.get(ws).episodes;
  const p = episodesPath(ws);
  let episodes = [];
  if (existsSync(p)) {
    episodes = readFileSync(p, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  cache.set(ws, { episodes, loaded: true });
  return episodes;
}

/**
 * Save a conversation episode.
 * @returns {object} the saved episode record
 */
export function saveEpisode(ws, { summary, decisions = [], mood = "", topics = [], participants = [], duration_minutes = null }) {
  const episode = {
    id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "episode",
    ts: new Date().toISOString(),
    summary,
    decisions,
    mood,
    topics,
    participants,
    duration_minutes,
  };

  mkdirSync(join(ws, "memory"), { recursive: true });
  appendFileSync(episodesPath(ws), JSON.stringify(episode) + "\n", "utf-8");

  if (cache.has(ws) && cache.get(ws).loaded) {
    cache.get(ws).episodes.push(episode);
  }

  return episode;
}

/**
 * Search episodes by query (hybrid: keyword + semantic) or get recent N.
 * @param {string} [query] - search query (if null, returns recent episodes)
 * @param {number} [lastN=5] - number of results
 * @returns {Promise<object[]>}
 */
export async function recallEpisodes(ws, query = null, lastN = 5) {
  const episodes = loadEpisodes(ws);
  if (episodes.length === 0) return [];

  // If no query, return most recent
  if (!query) {
    return episodes.slice(-lastN).reverse();
  }

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  // Try semantic search
  const queryEmb = await getEmbedding(query);
  const embCache = loadEmbeddingCache(ws);

  const scored = episodes.map((ep) => {
    // Build searchable text from all episode fields
    const text = [
      ep.summary || "",
      ...(ep.decisions || []),
      ...(ep.topics || []),
      ep.mood || "",
    ].join(" ").toLowerCase();

    // Keyword score
    let kwScore = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) kwScore += 1;
    }
    if (queryTerms.length > 1 && text.includes(queryLower)) kwScore += 3;

    // Semantic score
    let semScore = 0;
    if (queryEmb && ep.id && embCache[ep.id]) {
      semScore = Math.max(0, cosineSimilarity(queryEmb, embCache[ep.id]));
    }

    // Recency bonus
    let recencyScore = 0;
    if (ep.ts) {
      const ageDays = (Date.now() - new Date(ep.ts).getTime()) / 86400000;
      recencyScore = Math.max(0, 1 - ageDays / 90); // episodes decay faster (90 days)
    }

    const total = kwScore * 2 + semScore * 5 + recencyScore;
    return total > 0 ? { episode: ep, score: total } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, lastN).map((s) => s.episode);
}

/**
 * Index episode embedding for semantic search.
 */
export async function indexEpisodeEmbedding(ws, episode) {
  const text = [
    episode.summary,
    ...(episode.decisions || []),
    ...(episode.topics || []),
  ].filter(Boolean).join(" ");

  const emb = await getEmbedding(text);
  if (emb) {
    const embCache = loadEmbeddingCache(ws);
    embCache[episode.id] = emb;
    saveEmbeddingCache(ws);
  }
}
