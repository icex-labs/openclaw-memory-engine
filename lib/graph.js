/**
 * Knowledge Graph: triple store (subject, relation, object).
 * Enables relational queries like "who is George's doctor" or "what treats 荨麻疹".
 *
 * Storage: memory/graph.jsonl — one triple per line.
 * Auto-extraction: pattern-based extraction from archival insert content.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { graphPath } from "./paths.js";

// ─── In-memory cache ───

const cache = new Map(); // ws → { triples: [], loaded: false }

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

  // Deduplicate: same subject+relation+object
  const exists = triples.some(
    (t) => t.s === subject && t.r === relation && t.o === object,
  );
  if (exists) return null;

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

/**
 * Query the graph from a starting entity, optionally filtering by relation.
 * @param {string} entity - starting node
 * @param {string} [relation] - optional relation filter
 * @param {number} [depth=2] - traversal depth
 * @returns {Array<{ path: string[], triple: object }>}
 */
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
      // Forward: subject matches
      if (t.s.toLowerCase() === currentLower) {
        if (relation && t.r.toLowerCase() !== relation.toLowerCase()) continue;
        results.push({ path: [...path, `--${t.r}-->`], node: t.o, triple: t });
        traverse(t.o, currentDepth + 1, [...path, `--${t.r}-->`, t.o]);
      }
      // Reverse: object matches
      if (t.o.toLowerCase() === currentLower) {
        if (relation && t.r.toLowerCase() !== relation.toLowerCase()) continue;
        results.push({ path: [...path, `<--${t.r}--`], node: t.s, triple: t });
        traverse(t.s, currentDepth + 1, [...path, `<--${t.r}--`, t.s]);
      }
    }
  }

  traverse(entity, 1, [entity]);
  return results;
}

// ─── Auto-extraction patterns ───

const EXTRACTION_PATTERNS = [
  // "X's doctor is Y" / "X的医生是Y"
  { re: /(.+?)(?:'s|的)\s*(?:doctor|医生|主治医生)\s*(?:is|是|为)\s*(.+)/i, r: "has_doctor" },
  // "X lives in Y" / "X住在Y"
  { re: /(.+?)\s*(?:lives? in|住在|位于)\s*(.+)/i, r: "lives_in" },
  // "X works at Y" / "X在Y工作"
  { re: /(.+?)\s*(?:works? at|在(.+?)工作)/i, r: "works_at" },
  // "X has condition Y" / disease / 疾病
  { re: /(.+?)\s*(?:has|有|患有)\s*(?:chronic |慢性)?\s*(.+?(?:症|病|urticaria|condition|disease))/i, r: "has_condition" },
  // "X treated by/takes Y" / 用药
  { re: /(.+?)\s*(?:takes?|服用|用药|treated (?:by|with))\s*(.+)/i, r: "treated_by" },
  // "X's wife/husband is Y"
  { re: /(.+?)(?:'s|的)\s*(wife|husband|妻子|丈夫|老婆|老公)\s*(?:is|是|为)\s*(.+)/i, r: "spouse", triple: true },
  // "X's son/daughter is Y"
  { re: /(.+?)(?:'s|的)\s*(son|daughter|儿子|女儿)\s*(?:is|是|为)\s*(.+)/i, r: "has_child", triple: true },
  // "X costs/price Y" / 定价
  { re: /(.+?)\s*(?:costs?|定价|售价|price[ds]?\s*(?:at)?)\s*\$?([\d,.]+)/i, r: "price" },
  // "X's lawyer is Y"
  { re: /(.+?)(?:'s|的)\s*(?:lawyer|律师|attorney)\s*(?:is|是|为)\s*(.+)/i, r: "has_lawyer" },
  // "X owns Y" / 拥有
  { re: /(.+?)\s*(?:owns?|拥有|有一辆|drives?)\s*(.+)/i, r: "owns" },
  // "X studies/attends Y" / 就读
  { re: /(.+?)\s*(?:attends?|studies? at|就读于?|在(.+?)(?:上学|读书))/i, r: "attends" },
];

/**
 * Extract triples from a text string.
 * @returns {Array<{ s: string, r: string, o: string }>}
 */
export function extractTriples(text) {
  const results = [];
  for (const pat of EXTRACTION_PATTERNS) {
    const m = text.match(pat.re);
    if (m) {
      const s = (m[1] || "").trim();
      const o = (pat.triple ? m[3] : m[2] || "").trim();
      if (s && o && s.length < 50 && o.length < 80) {
        results.push({ s, r: pat.r, o });
      }
    }
  }
  return results;
}
