/**
 * Knowledge Graph: triple store (subject, relation, object).
 * v5.1: strict extraction — only extract triples from clear, short, structured statements.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { graphPath } from "./paths.js";

// ─── In-memory cache ───

const cache = new Map();

export function loadGraph(ws) {
  if (cache.has(ws) && cache.get(ws).loaded) return cache.get(ws).triples;
  const p = graphPath(ws);
  let triples = [];
  if (existsSync(p)) {
    triples = readFileSync(p, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  cache.set(ws, { triples, loaded: true });
  return triples;
}

export function addTriple(ws, subject, relation, object, sourceId = null) {
  const triples = loadGraph(ws);

  // Case-insensitive dedup to prevent "Edmonton" vs "edmonton" duplicates
  const exists = triples.some(
    (t) => t.s.toLowerCase() === subject.toLowerCase() &&
           t.r.toLowerCase() === relation.toLowerCase() &&
           t.o.toLowerCase() === object.toLowerCase(),
  );
  if (exists) return null;

  // Reject if subject or object is too long (garbage prevention)
  if (subject.length > 30 || object.length > 40) return null;

  const triple = {
    id: `tri-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    s: subject,
    r: relation,
    o: object,
    ts: new Date().toISOString(),
    source: sourceId,
  };

  mkdirSync(join(ws, "memory"), { recursive: true });
  appendFileSync(graphPath(ws), JSON.stringify(triple) + "\n", "utf-8");
  triples.push(triple);
  return triple;
}

export function removeTriple(ws, tripleId) {
  const triples = loadGraph(ws);
  const idx = triples.findIndex((t) => t.id === tripleId);
  if (idx === -1) return false;
  triples.splice(idx, 1);
  writeFileSync(graphPath(ws), triples.map((t) => JSON.stringify(t)).join("\n") + (triples.length ? "\n" : ""), "utf-8");
  return true;
}

export function queryGraph(ws, entity, relation = null, depth = 2) {
  const triples = loadGraph(ws);
  const entityLower = entity.toLowerCase();
  const results = [];
  const visited = new Set();

  function traverse(current, currentDepth, path) {
    if (currentDepth > depth) return;
    const key = `${current}:${currentDepth}`;
    if (visited.has(key)) return;
    visited.add(key);

    const currentLower = current.toLowerCase();
    for (const t of triples) {
      if (t.s.toLowerCase() === currentLower) {
        if (relation && t.r.toLowerCase() !== relation.toLowerCase()) continue;
        results.push({ path: [...path, `--${t.r}-->`], node: t.o, triple: { id: t.id, s: t.s, r: t.r, o: t.o } });
        traverse(t.o, currentDepth + 1, [...path, `--${t.r}-->`, t.o]);
      }
      if (t.o.toLowerCase() === currentLower) {
        if (relation && t.r.toLowerCase() !== relation.toLowerCase()) continue;
        results.push({ path: [...path, `<--${t.r}--`], node: t.s, triple: { id: t.id, s: t.s, r: t.r, o: t.o } });
        traverse(t.s, currentDepth + 1, [...path, `<--${t.r}--`, t.s]);
      }
    }
  }

  traverse(entity, 1, [entity]);
  return results;
}

// ─── Auto-extraction: strict patterns only ───

/**
 * Validate that a string looks like a proper entity name (not a sentence fragment).
 * - Must be short (≤25 chars)
 * - Must not contain markdown, code, or sentence-like patterns
 * - Must start with a capital letter or CJK character
 */
function isValidEntity(s) {
  if (!s || s.length > 25 || s.length < 2) return false;
  // Reject markdown, code, URLs, punctuation-heavy strings
  if (/[`*\[\]{}()|→←⚠#>]/.test(s)) return false;
  // Reject if it looks like a sentence (has verb-like patterns or too many words)
  if (s.split(/\s+/).length > 5) return false;
  // Must start with uppercase, CJK, or known pattern
  if (!/^[A-Z\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s)) return false;
  return true;
}

const EXTRACTION_PATTERNS = [
  // "X's doctor is Y"
  { re: /^([A-Z]\w+)(?:'s)\s+doctor\s+is\s+(.+)$/i, r: "has_doctor" },
  // "X's lawyer is Y"
  { re: /^([A-Z]\w+)(?:'s)\s+(?:lawyer|attorney)\s+is\s+(.+)$/i, r: "has_lawyer" },
  // "X lives in Y"
  { re: /^([A-Z]\w+)\s+lives?\s+in\s+([A-Z][\w\s,]+)$/i, r: "lives_in" },
  // "X works at Y"
  { re: /^([A-Z]\w+)\s+works?\s+at\s+([A-Z][\w\s&.]+)$/i, r: "works_at" },
  // "X owns Y" — only match short clear statements
  { re: /^([A-Z]\w+)\s+owns?\s+(?:a\s+)?([A-Z][\w\s]+)$/i, r: "owns" },
  // "X drives a Y"
  { re: /^([A-Z]\w+)\s+drives?\s+(?:a\s+)?([A-Z][\w\s]+)$/i, r: "owns" },
  // "X has chronic Y" / "X has Y disease/condition"
  { re: /^([A-Z]\w+)\s+has\s+(?:chronic\s+)?(\w[\w\s]*(?:disease|condition|syndrome|urticaria|diabetes|asthma))$/i, r: "has_condition" },
  // "X takes Y" (medication)
  { re: /^([A-Z]\w+)\s+takes?\s+([A-Z][\w\s]+\d+\s*mg)$/i, r: "treated_by" },
  // "X attends Y"
  { re: /^([A-Z]\w+)\s+attends?\s+([A-Z][\w\s]+)$/i, r: "attends" },
  // "X's wife/husband is Y"
  { re: /^([A-Z]\w+)(?:'s)\s+(?:wife|husband)\s+is\s+(.+)$/i, r: "spouse" },
  // "X's son/daughter is Y"
  { re: /^([A-Z]\w+)(?:'s)\s+(?:son|daughter)\s+is\s+(.+)$/i, r: "has_child" },
];

/**
 * Extract triples from a text string.
 * Strict: only matches clean, short statements with proper entity names.
 */
export function extractTriples(text) {
  const results = [];
  // Only try extraction on short, clear text (not paragraphs)
  if (text.length > 150) return results;

  for (const pat of EXTRACTION_PATTERNS) {
    const m = text.match(pat.re);
    if (m) {
      const s = (m[1] || "").trim();
      const o = (m[2] || "").trim();
      if (isValidEntity(s) && o.length >= 2 && o.length <= 40) {
        results.push({ s, r: pat.r, o });
      }
    }
  }
  return results;
}
