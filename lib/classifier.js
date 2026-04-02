/**
 * Embedding-based classifier — replaces all hardcoded regex patterns.
 * Language-agnostic: works with any language the embedding model supports.
 *
 * Uses "anchor embeddings" — short descriptions of each category.
 * Classifies by cosine similarity against anchors.
 * Anchors are computed once and cached to disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getEmbedding, cosineSimilarity } from "./embedding.js";

// ═══════════════════════════════════════════════════════════════════
// Category anchors — short descriptions, NOT keywords
// The embedding model understands semantics, so these work in ANY language
// ═══════════════════════════════════════════════════════════════════

const ENTITY_ANCHORS = {
  health: "medical health doctor hospital clinic medication prescription treatment diagnosis symptom illness disease checkup appointment therapy",
  finance: "money investment portfolio bank account mortgage loan interest rate tax income salary budget expense stock trading IBKR brokerage dividend",
  immigration: "immigration visa permanent resident citizenship passport border agency lawyer legal court petition complaint refugee asylum",
  legal: "lawyer attorney lawsuit court tribunal legal complaint case hearing judgment ruling contract",
  vehicles: "car vehicle automobile SUV sedan truck van tire wheel maintenance repair insurance collision driving license",
  property: "house home apartment condo real estate mortgage rent property landlord tenant renovation",
  education: "school student class homework exam test grade teacher professor university college kindergarten lesson tutorial",
  family: "wife husband spouse child son daughter parent mother father sibling family relative wedding anniversary",
  career: "job work career company employer employee salary promotion interview resume hiring office meeting boss manager",
  infrastructure: "server cluster kubernetes docker container deployment pipeline CI CD devops cloud hosting database",
  technology: "code programming software AI machine learning LLM model API plugin framework library",
  shopping: "buy purchase order shop store online delivery coupon discount price sale",
  travel: "flight airline airport hotel trip vacation travel booking passport luggage destination",
  food: "restaurant meal dinner lunch breakfast cooking recipe food grocery kitchen chef",
  entertainment: "movie music game sport hobby concert show streaming video book reading",
};

const IMPORTANCE_ANCHORS = {
  critical: "lawsuit court immigration visa legal case medical emergency surgery hospital critical urgent deadline account number password credential secret key",
  high: "investment portfolio large amount financial planning doctor appointment medical treatment insurance policy contract agreement major decision career change",
  medium: "project task deployment code fix feature technical work meeting schedule plan discussion regular maintenance",
  low: "casual chat greeting small talk weather joke daily routine trivial minor note acknowledgment ok thanks yes no",
};

const IMPORTANCE_SCORES = { critical: 9, high: 7, medium: 5, low: 3 };

// Threshold: if no anchor scores above this, keep default
const ENTITY_THRESHOLD = 0.3;
const IMPORTANCE_THRESHOLD = 0.25;

// ═══════════════════════════════════════════════════════════════════
// Anchor cache — compute once, reuse forever
// ═══════════════════════════════════════════════════════════════════

let anchorCache = null;
let anchorCachePath = null;

function getAnchorCachePath(ws) {
  return join(ws, "memory", "classifier-anchors.json");
}

async function loadAnchors(ws) {
  if (anchorCache) return anchorCache;

  const cachePath = getAnchorCachePath(ws);
  anchorCachePath = cachePath;

  // Try loading from disk
  if (existsSync(cachePath)) {
    try {
      anchorCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      // Validate: check if all categories are present
      const entityKeys = Object.keys(ENTITY_ANCHORS);
      const cachedKeys = Object.keys(anchorCache.entities || {});
      if (entityKeys.every((k) => cachedKeys.includes(k))) {
        return anchorCache;
      }
      // Cache incomplete, recompute
    } catch { /* recompute */ }
  }

  // Compute anchor embeddings
  console.error("[memory-engine] Computing classifier anchor embeddings...");
  const entities = {};
  for (const [name, desc] of Object.entries(ENTITY_ANCHORS)) {
    const emb = await getEmbedding(desc);
    if (emb) entities[name] = emb;
  }

  const importance = {};
  for (const [name, desc] of Object.entries(IMPORTANCE_ANCHORS)) {
    const emb = await getEmbedding(desc);
    if (emb) importance[name] = emb;
  }

  anchorCache = { entities, importance, version: 2 };

  // Save to disk
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(anchorCache), "utf-8");
  console.error(`[memory-engine] Anchor embeddings cached (${Object.keys(entities).length} entities, ${Object.keys(importance).length} importance levels)`);

  return anchorCache;
}

// ═══════════════════════════════════════════════════════════════════
// Classification functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify entity using embedding similarity.
 * @param {float[]} contentEmbedding - pre-computed embedding of the content
 * @param {string} ws - workspace path (for anchor cache)
 * @returns {Promise<string>} entity category or "general"
 */
export async function classifyEntity(contentEmbedding, ws) {
  if (!contentEmbedding) return "general";

  const anchors = await loadAnchors(ws);
  if (!anchors?.entities || Object.keys(anchors.entities).length === 0) return "general";

  let bestCategory = "general";
  let bestScore = ENTITY_THRESHOLD;

  for (const [category, anchorEmb] of Object.entries(anchors.entities)) {
    const sim = cosineSimilarity(contentEmbedding, anchorEmb);
    if (sim > bestScore) {
      bestScore = sim;
      bestCategory = category;
    }
  }

  return bestCategory;
}

/**
 * Rate importance using embedding similarity.
 * @param {float[]} contentEmbedding - pre-computed embedding
 * @param {string} ws - workspace path
 * @returns {Promise<number>} importance score 1-10
 */
export async function classifyImportance(contentEmbedding, ws) {
  if (!contentEmbedding) return 5;

  const anchors = await loadAnchors(ws);
  if (!anchors?.importance || Object.keys(anchors.importance).length === 0) return 5;

  let bestLevel = "medium";
  let bestScore = IMPORTANCE_THRESHOLD;

  for (const [level, anchorEmb] of Object.entries(anchors.importance)) {
    const sim = cosineSimilarity(contentEmbedding, anchorEmb);
    if (sim > bestScore) {
      bestScore = sim;
      bestLevel = level;
    }
  }

  return IMPORTANCE_SCORES[bestLevel] || 5;
}

/**
 * Lightweight fallback classifier — no embedding API needed.
 * Uses format/symbol signals that work across languages:
 *   - $ amounts → finance
 *   - URLs → technology
 *   - dates → general (but higher importance)
 *   - very short messages → low importance
 */
function fallbackClassify(content) {
  let entity = "general";
  let importance = 5;

  // Finance: currency symbols, large numbers
  if (/[\$€£¥₹]\s*[\d,.]+|\b\d{4,}[\d,.]*\b/.test(content)) {
    entity = "finance";
    importance = 7;
  }
  // Technology: URLs, code patterns, file paths
  else if (/https?:\/\/|```|\/\w+\/\w+|\.(js|py|ts|json|yaml|md)\b/i.test(content)) {
    entity = "technology";
  }
  // Dates with context → likely scheduling/planning
  else if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/.test(content)) {
    importance = 6;
  }

  // Short messages are less important
  if (content.length < 30) importance = Math.min(importance, 3);
  // Long detailed messages are more important
  if (content.length > 200) importance = Math.max(importance, 6);

  return { entity, importance };
}

/**
 * Full classification: entity + importance in one call.
 * Uses embedding similarity when available, falls back to format-based heuristics.
 * @param {string} content - text to classify
 * @param {string} ws - workspace path
 * @param {float[]} [existingEmbedding] - reuse if already computed
 * @returns {Promise<{ entity: string, importance: number, embedding: float[]|null }>}
 */
export async function classify(content, ws, existingEmbedding = null) {
  const emb = existingEmbedding || await getEmbedding(content);

  // If no embedding available (no API key), use fallback
  if (!emb) {
    const fb = fallbackClassify(content);
    return { entity: fb.entity, importance: fb.importance, embedding: null };
  }

  const [entity, importance] = await Promise.all([
    classifyEntity(emb, ws),
    classifyImportance(emb, ws),
  ]);
  return { entity, importance, embedding: emb };
}

/**
 * Batch re-classify existing records.
 * @param {string} ws - workspace path
 * @param {object[]} records - archival records with embeddings
 * @param {object} embeddingCache - { id: float[] }
 * @returns {Promise<{ reclassified: number, rerated: number }>}
 */
export async function batchReclassify(ws, records, embeddingCache) {
  await loadAnchors(ws); // ensure anchors are cached

  let reclassified = 0;
  let rerated = 0;

  for (const record of records) {
    const emb = embeddingCache[record.id];
    if (!emb) continue;

    const newEntity = await classifyEntity(emb, ws);
    if (newEntity !== "general" && record.entity === "general") {
      record.entity = newEntity;
      reclassified++;
    }

    const currentImp = record.importance ?? 5;
    if (currentImp === 5) { // only re-rate flat defaults
      const newImp = await classifyImportance(emb, ws);
      if (newImp !== 5) {
        record.importance = newImp;
        rerated++;
      }
    }
  }

  return { reclassified, rerated };
}
