/**
 * Archival storage: unlimited append-only JSONL with in-memory index.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { archivalPath, DEFAULT_IMPORTANCE } from "./paths.js";

export { archivalPath };

/** In-memory cache keyed by workspace path. */
const cache = new Map();

export function loadArchival(ws) {
  if (cache.has(ws) && cache.get(ws).loaded) return cache.get(ws).records;
  const p = archivalPath(ws);
  let records = [];
  if (existsSync(p)) {
    records = readFileSync(p, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  cache.set(ws, { records, loaded: true });
  return records;
}

export function appendRecord(ws, entry) {
  const record = {
    id: `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    last_accessed: null,
    access_count: 0,
    importance: entry.importance ?? DEFAULT_IMPORTANCE,
    ...entry,
  };
  mkdirSync(join(ws, "memory"), { recursive: true });
  appendFileSync(archivalPath(ws), JSON.stringify(record) + "\n", "utf-8");
  if (cache.has(ws) && cache.get(ws).loaded) {
    cache.get(ws).records.push(record);
  }
  return record;
}

export function rewriteArchival(ws, records) {
  writeFileSync(
    archivalPath(ws),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
  cache.set(ws, { records: [...records], loaded: true });
}
